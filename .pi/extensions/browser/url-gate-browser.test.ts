import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Live verification of the browser half of url-gate: real Chromium, a real local
// HTTP server, and the REAL registered Browser* tools invoked the way pi invokes
// them. Nothing on the browser side is mocked, and the assertions are made on
// the SERVER's hit log — the strongest proof available that a refused destination
// never reached the network at all, rather than "the tool printed some text".
//
// On-list vs off-list is ONE server reached on two ports: the whitelist admits
// `127.0.0.1:<port>`, so `127.0.0.1:<offPort>` is off-list. Same code, same
// address, no DNS, no external network.
//
// Deliberately NOT a hostname pair (localhost vs 127.0.0.1): measured here,
// Chromium's own local-network checks refuse a `localhost` SUBRESOURCE from a
// `127.0.0.1` page with no gate installed at all, so a subresource assertion
// built that way passes whether the gate works or not. A second port is off-list
// for exactly the reason the list says it is.
//
// What this covers that the pure gate.test.ts cannot: the destinations that never
// appear in a tool input — the whole reason the gate had to move below the tool
// layer. A BrowserClick on an off-list link, a form post, a server 302 hop from
// an on-list URL to an off-list one, a meta refresh, a JS location.href, a
// target=_blank link, an off-list entry coming back through BrowserBack, and the
// subresource policy that differs between main-frame and all mode.
//
// Skips itself when the chromium binary is absent, so a machine without
// `npx playwright install chromium` reports a skip rather than a failure.

const HAS_CHROMIUM = existsSync(join(process.env.HOME || "", ".cache/ms-playwright"));

type Tool = { execute: (id: string, input: any) => Promise<any> };

let server: ReturnType<typeof createServer>;
let offServer: ReturnType<typeof createServer>;
let port = 0;
let offPort = 0;
const savedEnv: Record<string, string | undefined> = {};
const hits: string[] = [];
const tools = new Map<string, Tool>();

// 1x1 GIF, served as the subresource probe.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function routePage(path: string): string | null {
  const off = `http://127.0.0.1:${offPort}`;
  const on = `http://127.0.0.1:${port}`;
  if (path === "/a")
    return `<!doctype html><html><head><meta charset="utf-8"><title>on-list</title></head><body><h1>ONLIST</h1>
<a id="offlink" href="${off}/offsite">off</a>
<a id="onlink" href="${on}/b">on</a>
<a id="pop" href="${off}/offsite" target="_blank">pop</a>
<form id="offform" action="${off}/offsite"><button id="offbtn" type="submit">go</button></form>
</body></html>`;
  if (path === "/b") return `<!doctype html><html><head><title>b</title></head><body><h1>PAGE-B</h1></body></html>`;
  if (path === "/offsite") return `<!doctype html><html><body><h1>OFFSITE-REACHED</h1></body></html>`;
  if (path === "/meta")
    return `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${off}/offsite"></head><body><h1>META-HOLD</h1></body></html>`;
  if (path === "/jsredirect")
    return `<!doctype html><html><body><h1>JS-HOLD</h1><script>location.href="${off}/offsite";</script></body></html>`;
  if (path === "/sub")
    return `<!doctype html><html><body><h1>SUB</h1><img id="px" src="${off}/px.gif"></body></html>`;
  if (path === "/apng")
    return `<!doctype html><html><body><h1>APNG</h1><img id="px" src="${on}/px.gif"></body></html>`;
  if (path === "/gz") return null; // handled below, gzipped
  return null;
}

function handler(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url || "/").split("?")[0];
  hits.push(`${req.headers.host ?? "?"}${path}`);
  if (path === "/redirect302") {
    res.writeHead(302, { Location: `http://127.0.0.1:${offPort}/offsite` });
    res.end();
    return;
  }
  if (path === "/redirect-on") {
    res.writeHead(302, { Location: `http://127.0.0.1:${port}/b` });
    res.end();
    return;
  }
  if (path === "/gz") {
    const body = gzipSync(Buffer.from("<!doctype html><html><body><h1>GZIPPED-OK</h1></body></html>"));
    res.writeHead(200, {
      "content-type": "text/html",
      "content-encoding": "gzip",
      "content-length": String(body.length),
      "cache-control": "no-store",
    });
    res.end(body);
    return;
  }
  if (path === "/px.gif") {
    res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
    res.end(GIF);
    return;
  }
  const html = routePage(path);
  if (html === null) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<h1>404</h1>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end(html);
}

async function call(name: string, input: any = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} was never registered`);
  const res = await tool.execute(`t-${name}`, input);
  return { text: (res?.content?.[0]?.text ?? "") as string, isError: !!res?.isError };
}

const offsite = () => `http://127.0.0.1:${offPort}/offsite`;
const onsite = (p = "/a") => `http://127.0.0.1:${port}${p}`;
const reachedOffsite = () => hits.some((h) => h.endsWith("/offsite"));
const offHits = () => hits.filter((h) => h.includes(`:${offPort}/`));

beforeAll(async () => {
  if (!HAS_CHROMIUM) return;

  server = createServer(handler);
  offServer = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => offServer.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
  offPort = (offServer.address() as any).port;

  const wlDir = mkdtempSync(join(tmpdir(), "url-gate-browser-"));
  const wl = join(wlDir, "url-whitelist.json");
  writeFileSync(wl, JSON.stringify({ allowed: [`127.0.0.1:${port}`] }));

  savedEnv.LITTLE_CODER_URL_WHITELIST = process.env.LITTLE_CODER_URL_WHITELIST;
  savedEnv.LITTLE_CODER_URL_GATE = process.env.LITTLE_CODER_URL_GATE;
  savedEnv.LITTLE_CODER_URL_GATE_BROWSER = process.env.LITTLE_CODER_URL_GATE_BROWSER;
  process.env.LITTLE_CODER_URL_WHITELIST = wl;
  delete process.env.LITTLE_CODER_URL_GATE;
  delete process.env.LITTLE_CODER_URL_GATE_BROWSER;

  // Register the real extension: pi's registerTool/on surface stubbed only
  // enough to capture the tool handlers, which are then executed unchanged.
  const { default: registerBrowser } = await import("./index.ts");
  const pi: any = { on: () => {}, registerTool: (t: any) => tools.set(t.name, t) };
  registerBrowser(pi);
}, 120_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (!HAS_CHROMIUM) return;
  const { resetBrowserSession } = await import("./index.ts");
  await resetBrowserSession();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => offServer.close(() => r()));
});

beforeEach(async () => {
  if (!HAS_CHROMIUM) return;
  hits.length = 0;
  // Modes are read at page launch and two cases below change them, so every
  // case starts from the default — otherwise a later one inherits an "off" and
  // passes for the wrong reason.
  delete process.env.LITTLE_CODER_URL_GATE;
  delete process.env.LITTLE_CODER_URL_GATE_BROWSER;
  // Fresh page per case: the gate attaches at page launch and reads the mode
  // then, so a mode change needs a new session.
  const { resetBrowserSession } = await import("./index.ts");
  await resetBrowserSession();
  const gate = await import("../url-gate/gate.ts");
  gate.clearSessionAllowed();
});

describe.skipIf(!HAS_CHROMIUM)("url-gate browser request gate — live chromium", () => {
  it("is running the strong layer (CDP), not the page.route() fallback", async () => {
    // Guards a failure mode that is invisible from tool results: if the CDP
    // session cannot be opened the gate quietly drops to page.route(), which
    // does NOT block redirect hops. That happened once — the gate was installed
    // before sess.context was assigned — and every other test still passed,
    // because not all of them depend on hops. So name the layer explicitly.
    await call("BrowserNavigate", { url: onsite("/a") });
    const { browserGateLayer } = await import("./index.ts");
    expect(browserGateLayer()).toBe("cdp");
  });

  it("lets the whitelisted host through, and says so plainly", async () => {
    const r = await call("BrowserNavigate", { url: onsite("/a") });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("status=200");
    expect(hits).toContain(`127.0.0.1:${port}/a`);
  });

  it("blocks a BrowserNavigate to an off-list port at the network layer", async () => {
    // In a live session the tool_call hook prompts first, and a "yes" records
    // the host in sessionAllowedHosts so the request gate lets it through. With
    // no approval recorded, the request itself must never arrive.
    const r = await call("BrowserNavigate", { url: offsite() });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ERR_BLOCKED_BY_CLIENT|blocked/i);
    expect(reachedOffsite()).toBe(false);
  });

  it("blocks a BrowserClick navigation the model never named a URL for", async () => {
    await call("BrowserNavigate", { url: onsite("/a") });
    const r = await call("BrowserClick", { selector: "#offlink" });
    expect(reachedOffsite()).toBe(false);
    // The click succeeded — what it triggered did not. The result has to say
    // so, or "clicked. url=<unchanged>" reads as a success.
    expect(r.text).toContain("clicked");
    expect(r.text).toContain("not on the URL whitelist");
    expect(r.text).toContain(offsite());
    // And history stays clean: a refused destination must not sit in the stack
    // for a later BrowserBack to re-surface.
    const h = await call("BrowserHistory");
    expect(h.text).not.toContain(String(offPort));
  });

  it("allows a BrowserClick to an on-list host", async () => {
    await call("BrowserNavigate", { url: onsite("/a") });
    const r = await call("BrowserClick", { selector: "#onlink" });
    expect(r.text).toContain("clicked");
    expect(r.text).not.toContain("not on the URL whitelist");
    expect(hits).toContain(`127.0.0.1:${port}/b`);
  });

  it("blocks a form submit that posts to an off-list host", async () => {
    await call("BrowserNavigate", { url: onsite("/a") });
    await call("BrowserClick", { selector: "#offbtn" });
    expect(reachedOffsite()).toBe(false);
  });

  it("refuses a target=_blank link to an off-list host", async () => {
    // A popup would be a new target the gate never attached to — attaching loses
    // to Chromium's head start, measured. So target=_blank is folded back into
    // the gated page, where the normal rules refuse it and the model sees why.
    await call("BrowserNavigate", { url: onsite("/a") });
    await call("BrowserClick", { selector: "#pop" });
    await new Promise((r) => setTimeout(r, 600));
    expect(reachedOffsite()).toBe(false);
  });

  it("blocks a 302 redirect HOP from an on-list URL to an off-list one", async () => {
    // The browser's own hop chain, separate from webfetch's manual walk: an
    // on-list start must not launder an off-list target. The hop is refused
    // before it is dialed, so the off-list port was never contacted at all.
    const r = await call("BrowserNavigate", { url: onsite("/redirect302") });
    expect(hits).toContain(`127.0.0.1:${port}/redirect302`);
    expect(reachedOffsite()).toBe(false);
    expect(offHits()).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not on the URL whitelist");
  });

  it("follows a redirect chain that stays on-list, and renders the target", async () => {
    // The gate must not break ordinary redirects. Known trade-off of CDP-level
    // gating noted in request-gate.ts: nothing here changes what the browser
    // itself does with a chain, so this is the "we did not break the web" test.
    const r = await call("BrowserNavigate", { url: onsite("/redirect-on") });
    expect(r.isError).toBe(false);
    expect(hits).toContain(`127.0.0.1:${port}/redirect-on`);
    expect(hits).toContain(`127.0.0.1:${port}/b`);
    const ex = await call("BrowserExtract");
    expect(ex.text).toContain("PAGE-B");
  });

  it("a gzipped page still extracts — the body is not decoded twice", async () => {
    await call("BrowserNavigate", { url: onsite("/gz") });
    const ex = await call("BrowserExtract");
    expect(ex.text).toContain("GZIPPED-OK");
  });

  it("blocks a meta-refresh navigation", async () => {
    await call("BrowserNavigate", { url: onsite("/meta") });
    await new Promise((r) => setTimeout(r, 500));
    expect(reachedOffsite()).toBe(false);
  });

  it("blocks a JS location.href navigation", async () => {
    await call("BrowserNavigate", { url: onsite("/jsredirect") });
    await new Promise((r) => setTimeout(r, 500));
    expect(reachedOffsite()).toBe(false);
  });

  it("blocks a BrowserBack that would re-navigate an off-list history entry", async () => {
    // Reach off-list legitimately (an approved host), move to an on-list page,
    // then withdraw the approval and go back: a history entry must not be a way
    // around the list.
    const gate = await import("../url-gate/gate.ts");
    gate.rememberHost(offsite());
    await call("BrowserNavigate", { url: offsite() });
    expect(reachedOffsite()).toBe(true);
    await call("BrowserNavigate", { url: onsite("/a") });

    gate.clearSessionAllowed();
    hits.length = 0;
    await call("BrowserBack");
    expect(reachedOffsite()).toBe(false);
  });

  it("main-frame mode (the default) leaves subresources alone", async () => {
    // The default mode's whole point: the user approved a page, not a host
    // boundary around its assets, so a real site still renders.
    await call("BrowserNavigate", { url: onsite("/sub") });
    await new Promise((r) => setTimeout(r, 500));
    expect(hits).toContain(`127.0.0.1:${offPort}/px.gif`);
    expect(reachedOffsite()).toBe(false);
  });

  it("all mode blocks subresources too, and still serves on-list ones", async () => {
    process.env.LITTLE_CODER_URL_GATE_BROWSER = "all";
    await call("BrowserNavigate", { url: onsite("/sub") });
    await new Promise((r) => setTimeout(r, 500));
    expect(offHits()).toEqual([]);

    hits.length = 0;
    await call("BrowserNavigate", { url: onsite("/apng") });
    await new Promise((r) => setTimeout(r, 500));
    expect(hits).toContain(`127.0.0.1:${port}/px.gif`);
  });

  it("off mode installs no interception at all", async () => {
    process.env.LITTLE_CODER_URL_GATE_BROWSER = "off";
    const r = await call("BrowserNavigate", { url: offsite() });
    expect(r.isError).toBe(false);
    expect(reachedOffsite()).toBe(true);
    const { browserGateLayer } = await import("./index.ts");
    expect(browserGateLayer()).toBeUndefined();
  });

  it("a host the user approved this session passes the request gate too", async () => {
    // The hook's "yes, allow it" answer has to reach the browser layer as well,
    // or approving a URL in the prompt would still yield a blocked page.
    const gate = await import("../url-gate/gate.ts");
    gate.rememberHost(offsite());
    const r = await call("BrowserNavigate", { url: offsite() });
    expect(r.isError).toBe(false);
    expect(reachedOffsite()).toBe(true);
  });
});
