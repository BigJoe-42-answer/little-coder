import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic provider/search tests (the url-gate-browser.test.ts pattern): a
// local http server on 127.0.0.1 answering /search with the LIVE SearXNG JSON
// shape recorded in docs/web-search-open-plan.md §0 — top level {query,
// results[], answers, corrections, infoboxes, suggestions,
// unresponsive_engines}, each result {title, url, content, engine, engines,
// score, category, parsed_url}. No external network, ever.

type Tool = { execute: (id: string, input: any, signal?: AbortSignal) => Promise<any> };

let server: ReturnType<typeof createServer>;
let port = 0;
const tools = new Map<string, Tool>();
const savedEnv: Record<string, string | undefined> = {};

/** One result in the shape observed live on 2026-11-26. */
function result(i: number) {
  return {
    title: `Result ${i} title`,
    url: `https://site${i}.example/page${i}`,
    content: `Snippet ${i}: the content field is the snippet SearXNG shows.`,
    engine: "google",
    engines: ["google", "bing"],
    score: 1 / (i + 1),
    category: "general",
    parsed_url: ["https", "site" + i + ".example", "/page" + i, "", ""],
    publishedDate: "2026-11-01T00:00:00Z",
  };
}

/** A full live-shaped document: 10 results (so the top-8 cap is observable). */
function searxngDoc(n = 10) {
  return {
    query: "test query",
    number_of_results: 0,
    results: Array.from({ length: n }, (_, i) => result(i + 1)),
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: [],
    unresponsive_engines: [["brave", "error"]],
  };
}

function handler(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url || "/", "http://127.0.0.1");
  const path = u.pathname;
  // Mode is picked by the PATH prefix of the base URL (e.g. base
  // http://127.0.0.1:P/404 makes the tool dial /404/search), because the tool
  // url-encodes the query and cannot smuggle extra parameters through it.
  const mode = /^\/(404|malformed|noresults|slow)\//.exec(path)?.[1] ?? "ok";
  if (path === "/search" || path.endsWith("/search")) {
    if (mode === "404") {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<h1>Not Found</h1>");
      return;
    }
    if (mode === "malformed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"query": "broken", "results": [');
      return;
    }
    if (mode === "noresults") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...searxngDoc(0), results: [] }));
      return;
    }
    if (mode === "slow") {
      // Never answers within the test's timeout; the socket is left open.
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(searxngDoc()));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("no route");
}

function setEnv(name: string, value: string | undefined) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function callSearch(input: any, signal?: AbortSignal) {
  const tool = tools.get("websearch");
  if (!tool) throw new Error("websearch was never registered");
  const res = await tool.execute("t-websearch", input, signal);
  return { text: (res?.content?.[0]?.text ?? "") as string, isError: !!res?.isError };
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;

  const { default: registerExtra } = await import("./index.ts");
  const pi: any = { on: () => {}, registerTool: (t: any) => tools.set(t.name, t) };
  registerExtra(pi);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  setEnv("LITTLE_CODER_WEB_PROVIDER", undefined);
  setEnv("SEARXNG_URL", undefined);
});

describe("resolveSearchProvider", () => {
  it("defaults to duckduckgo when unset or empty", async () => {
    const { resolveSearchProvider } = await import("./search.ts");
    expect(resolveSearchProvider({})).toBe("duckduckgo");
    expect(resolveSearchProvider({ LITTLE_CODER_WEB_PROVIDER: "  " })).toBe("duckduckgo");
    expect(resolveSearchProvider({ LITTLE_CODER_WEB_PROVIDER: "duckduckgo" })).toBe("duckduckgo");
  });
  it("accepts searxng, case- and whitespace-insensitively", async () => {
    const { resolveSearchProvider } = await import("./search.ts");
    expect(resolveSearchProvider({ LITTLE_CODER_WEB_PROVIDER: " SearXNG " })).toBe("searxng");
  });
  it("throws on an unknown value, naming the variable and the bad value", async () => {
    const { resolveSearchProvider } = await import("./search.ts");
    expect(() => resolveSearchProvider({ LITTLE_CODER_WEB_PROVIDER: "paralell" })).toThrow(
      /LITTLE_CODER_WEB_PROVIDER.*paralell.*duckduckgo.*searxng/s,
    );
  });
});

describe("searxngBaseUrl", () => {
  it("throws naming SEARXNG_URL when unset", async () => {
    const { searxngBaseUrl } = await import("./search.ts");
    expect(() => searxngBaseUrl({ LITTLE_CODER_WEB_PROVIDER: "searxng" })).toThrow(/SEARXNG_URL is not set/);
  });
  it("throws on a malformed or non-http URL", async () => {
    const { searxngBaseUrl } = await import("./search.ts");
    expect(() => searxngBaseUrl({ SEARXNG_URL: "not a url" })).toThrow(/SEARXNG_URL.*not a valid URL/);
    expect(() => searxngBaseUrl({ SEARXNG_URL: "ftp://x.example" })).toThrow(/must be an http\(s\) URL/);
  });
  it("strips trailing slashes", async () => {
    const { searxngBaseUrl } = await import("./search.ts");
    expect(searxngBaseUrl({ SEARXNG_URL: "http://127.0.0.1:8888//" })).toBe("http://127.0.0.1:8888");
  });
});

describe("searxngSearch against the local fixture", () => {
  it("maps results[] to the tool's Markdown shape and caps at 8", async () => {
    const { searxngSearch } = await import("./search.ts");
    const out = await searxngSearch("test query", { baseUrl: `http://127.0.0.1:${port}` });
    // Fixture has 10 results; the tool shape is **title**\nurl\nsnippet.
    expect(out).toContain("**Result 1 title**\nhttps://site1.example/page1\n");
    expect(out).toContain("Snippet 1: the content field is the snippet");
    expect(out).toContain("**Result 8 title**");
    expect(out).not.toContain("**Result 9 title**");
    expect(out.split("\n\n").length).toBe(8);
  });

  it("the tool end-to-end: provider=searxng + SEARXNG_URL hits the fixture", async () => {
    setEnv("LITTLE_CODER_WEB_PROVIDER", "searxng");
    setEnv("SEARXNG_URL", `http://127.0.0.1:${port}`);
    const r = await callSearch({ query: "test query" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("**Result 1 title**");
    expect(r.text).not.toContain("**Result 9 title**");
  });

  it("provider=searxng without SEARXNG_URL errors naming the variable, no DDG fallback", async () => {
    setEnv("LITTLE_CODER_WEB_PROVIDER", "searxng");
    const r = await callSearch({ query: "anything" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("SEARXNG_URL is not set");
  });

  it("a typo in the provider errors naming the variable and the value", async () => {
    setEnv("LITTLE_CODER_WEB_PROVIDER", "paralell");
    const r = await callSearch({ query: "anything" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('LITTLE_CODER_WEB_PROVIDER="paralell"');
  });

  it("a 404 from the instance errors naming the instance URL", async () => {
    const { searxngSearch } = await import("./search.ts");
    await expect(
      searxngSearch("q", { baseUrl: `http://127.0.0.1:${port}/404` }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("malformed JSON errors naming the instance and the json format knob", async () => {
    const { searxngSearch } = await import("./search.ts");
    await expect(
      searxngSearch("q", { baseUrl: `http://127.0.0.1:${port}/malformed` }),
    ).rejects.toThrow(/did not return JSON/);
  });

  it("an empty results array renders the same No results found as DDG", async () => {
    const { searxngSearch } = await import("./search.ts");
    const out = await searxngSearch("q", { baseUrl: `http://127.0.0.1:${port}/noresults` });
    expect(out).toBe("No results found");
  });

  it("a hung instance hits the timeout ceiling and names it", async () => {
    const { searxngSearch } = await import("./search.ts");
    const started = Date.now();
    await expect(
      searxngSearch("q", { baseUrl: `http://127.0.0.1:${port}/slow`, timeoutMs: 300 }),
    ).rejects.toThrow(/did not answer within 0\.3s/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an aborted signal aborts mid-fetch (the DDG path cannot be tested this way)", async () => {
    const { searxngSearch } = await import("./search.ts");
    const c = new AbortController();
    setTimeout(() => c.abort(), 100).unref?.();
    await expect(
      searxngSearch("q", { baseUrl: `http://127.0.0.1:${port}/slow`, timeoutMs: 30_000, signal: c.signal }),
    ).rejects.toThrow(/abort/i);
  });
});

describe("renderSearxngResults", () => {
  it("skips results without a url and titles untitled ones", async () => {
    const { renderSearxngResults } = await import("./search.ts");
    const out = renderSearxngResults([
      { title: "No url", content: "x" },
      { url: "https://a.example", content: "has url, no title" },
    ]);
    expect(out).toBe("**(untitled)**\nhttps://a.example\nhas url, no title");
  });
  it("an empty list is No results found", async () => {
    const { renderSearxngResults } = await import("./search.ts");
    expect(renderSearxngResults([])).toBe("No results found");
  });
});

describe("sub-coder reach (§2.5 pin)", () => {
  it("a child process with the inherited env resolves the same provider", async () => {
    // Sub-coders inherit the launcher env, so the provider reaches them for
    // free — this pins that claim the way #139 states it: spawn a real child
    // with the parent env (what subagent/spawn.ts does), have it import the
    // SAME search.ts and resolve from process.env, and require the answer to
    // match the parent's.
    const { resolveSearchProvider } = await import("./search.ts");
    setEnv("LITTLE_CODER_WEB_PROVIDER", "searxng");
    setEnv("SEARXNG_URL", "http://127.0.0.1:8888");
    expect(resolveSearchProvider()).toBe("searxng");

    const searchTs = join(fileURLToPath(import.meta.url), "..", "search.ts");
    const child = join(mkdtempSync(join(tmpdir(), "lc-provider-child-")), "child.ts");
    writeFileSync(
      child,
      `import { resolveSearchProvider } from ${JSON.stringify(searchTs)};\n` +
        `console.log(resolveSearchProvider(process.env));\n`,
    );
    // Node enables .ts type-stripping by default from v23; older supported
    // runtimes (engines >= 22.19) need the experimental flag.
    const major = Number(process.versions.node.split(".")[0]);
    const flags = major >= 23 ? [] : ["--experimental-strip-types"];
    const out = execFileSync(process.execPath, [...flags, child], {
      env: process.env,
      encoding: "utf8",
    }).trim();
    expect(out).toBe("searxng");
  });
});
