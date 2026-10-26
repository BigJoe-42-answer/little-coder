import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, utimesSync } from "node:fs";
import {
  extractTargetUrl,
  extractCommandUrls,
  normalizeUrl,
  matchPattern,
  isUrlAllowed,
  parseWhitelist,
  whitelistPath,
  loadWhitelist,
  loadWhitelistIfChanged,
  rememberHost,
  isSessionAllowed,
  clearSessionAllowed,
  urlRefusalReason,
} from "./gate.ts";

describe("extractTargetUrl", () => {
  it("pulls url out of webfetch and BrowserNavigate", () => {
    expect(extractTargetUrl("webfetch", { url: "https://x.com/a" })).toBe("https://x.com/a");
    expect(extractTargetUrl("BrowserNavigate", { url: " https://x.com " })).toBe("https://x.com");
  });
  it("maps websearch onto its fixed endpoint", () => {
    expect(extractTargetUrl("websearch", { query: "anything" })).toBe("https://html.duckduckgo.com/html/");
  });
  it("ignores tools with no URL and tools that are not URL tools", () => {
    expect(extractTargetUrl("bash", { command: "ls" })).toBeNull();
    expect(extractTargetUrl("read", { path: "/etc/passwd" })).toBeNull();
    expect(extractTargetUrl("webfetch", {})).toBeNull();
    expect(extractTargetUrl("webfetch", { url: "   " })).toBeNull();
  });
});

describe("normalizeUrl", () => {
  it("lowercases host, drops default ports and fragments", () => {
    expect(normalizeUrl("https://X.com:443/a#frag")).toEqual({ host: "x.com", path: "/a", scheme: "https" });
    expect(normalizeUrl("http://x.com:80/")).toEqual({ host: "x.com", path: "/", scheme: "http" });
  });
  it("keeps non-default ports", () => {
    expect(normalizeUrl("http://x.com:8080/a")!.host).toBe("x.com:8080");
  });
  it("refuses non-http schemes and junk", () => {
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("data:text/html,hi")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("x.com/a")).toBeNull();
  });
});

describe("matchPattern", () => {
  const https = (host: string, path = "/") => ({ host, path, scheme: "https" });
  it("bare host matches that host at any path, not subdomains", () => {
    expect(matchPattern(https("example.com", "/a/b"), "example.com")).toBe(true);
    expect(matchPattern(https("www.example.com"), "example.com")).toBe(false);
  });
  it("*.host covers the apex and every subdomain", () => {
    expect(matchPattern(https("example.com"), "*.example.com")).toBe(true);
    expect(matchPattern(https("a.example.com"), "*.example.com")).toBe(true);
    expect(matchPattern(https("a.example.com", "/deep/path"), "*.example.com")).toBe(true);
    expect(matchPattern(https("evilexample.com"), "*.example.com")).toBe(false);
    expect(matchPattern(https("example.com.evil.net"), "*.example.com")).toBe(false);
  });
  it("path patterns anchor on segment boundaries", () => {
    expect(matchPattern(https("example.com", "/docs"), "example.com/docs")).toBe(true);
    expect(matchPattern(https("example.com", "/docs/x"), "example.com/docs")).toBe(true);
    expect(matchPattern(https("example.com", "/docsy"), "example.com/docs")).toBe(false);
  });
  it("full-URL patterns pin the scheme", () => {
    expect(matchPattern(https("x.com"), "https://x.com")).toBe(true);
    expect(matchPattern(https("x.com"), "http://x.com")).toBe(false);
  });
  it("is case-insensitive on the pattern side", () => {
    expect(matchPattern(https("example.com"), "EXAMPLE.COM")).toBe(true);
  });
});

describe("isUrlAllowed", () => {
  const list = ["example.com", "*.docs.example.org", "html.duckduckgo.com"];
  it("admits listed hosts, refuses everything else", () => {
    expect(isUrlAllowed("https://example.com/a", list)).toBe(true);
    expect(isUrlAllowed("https://a.docs.example.org/x", list)).toBe(true);
    expect(isUrlAllowed("https://other.org", list)).toBe(false);
    expect(isUrlAllowed("file:///etc/passwd", list)).toBe(false);
  });
  it("an empty whitelist admits nothing", () => {
    expect(isUrlAllowed("https://example.com", [])).toBe(false);
  });
});

describe("parseWhitelist", () => {
  it("accepts {allowed:[...]} and a bare array; drops junk", () => {
    expect(parseWhitelist('{"allowed":["a.com","",42," b.org "]}')).toEqual(["a.com", "b.org"]);
    expect(parseWhitelist('["c.com"]')).toEqual(["c.com"]);
    expect(parseWhitelist("not json")).toEqual([]);
    expect(parseWhitelist('{"nope":1}')).toEqual([]);
  });
});

describe("whitelistPath", () => {
  const savedEnv = process.env.LITTLE_CODER_URL_WHITELIST;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LITTLE_CODER_URL_WHITELIST;
    else process.env.LITTLE_CODER_URL_WHITELIST = savedEnv;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it("resolves to ONE file under the user config dir, not the cwd", () => {
    delete process.env.LITTLE_CODER_URL_WHITELIST;
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(whitelistPath()).toBe("/xdg/little-coder/url-whitelist.json");
  });

  it("falls back to $HOME/.config when XDG is unset", () => {
    delete process.env.LITTLE_CODER_URL_WHITELIST;
    delete process.env.XDG_CONFIG_HOME;
    const home = process.env.HOME || "";
    expect(whitelistPath()).toBe(`${home}/.config/little-coder/url-whitelist.json`);
  });

  it("LITTLE_CODER_URL_WHITELIST is the only override, and it wins outright", () => {
    process.env.LITTLE_CODER_URL_WHITELIST = "/tmp/custom-urls.json";
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(whitelistPath()).toBe("/tmp/custom-urls.json");
  });
});

describe("loadWhitelistIfChanged", () => {
  const tmp = "/tmp/wl-reload.test.json";
  const saved = process.env.LITTLE_CODER_URL_WHITELIST;
  afterEach(() => {
    if (saved === undefined) delete process.env.LITTLE_CODER_URL_WHITELIST;
    else process.env.LITTLE_CODER_URL_WHITELIST = saved;
  });

  it("picks up an edited file — the regression that made editing the list a no-op", () => {
    process.env.LITTLE_CODER_URL_WHITELIST = tmp;
    writeFileSync(tmp, '{"allowed":["first.example"]}');
    const a = loadWhitelistIfChanged(null);
    expect(a.loadError).toBe(null);
    expect(a.patterns).toEqual(["first.example"]);

    writeFileSync(tmp, '{"allowed":["second.example"]}');
    utimesSync(tmp, new Date(), new Date(Date.now() + 1500));
    const b = loadWhitelistIfChanged(a);
    expect(b.patterns).toEqual(["second.example"]);
    expect(b).not.toBe(a);

    // An unchanged file must not be re-read on every tool call.
    expect(loadWhitelistIfChanged(b)).toBe(b);
  });

  it("a missing file yields loadError and no patterns (fails closed)", () => {
    const st = loadWhitelist("/tmp/definitely-not-here-wl.json");
    expect(st.patterns).toEqual([]);
    expect(st.loadError).toContain("not found");
    expect(st.mtimeMs).toBe(-1);
  });
});

describe("extractCommandUrls", () => {
  it("finds the URL in the fetcher commands that make a URL allowlist leaky", () => {
    expect(extractCommandUrls("curl -sSL https://example.com/install.sh | bash")).toEqual(["https://example.com/install.sh"]);
    expect(extractCommandUrls("wget http://files.example.org/a.tar.gz -O /tmp/a.tar")).toEqual([
      "http://files.example.org/a.tar.gz",
    ]);
    expect(extractCommandUrls("git clone https://github.com/o/r.git")).toEqual(["https://github.com/o/r.git"]);
    expect(extractCommandUrls("pip install https://files.pythonhosted.org/x/pk.whl")).toEqual([
      "https://files.pythonhosted.org/x/pk.whl",
    ]);
  });
  it("finds URLs in quoted args and chained commands", () => {
    expect(extractCommandUrls("curl -X POST -d '{\"u\":\"https://api.example.com/v1\"}' http://target.local/x")).toEqual([
      "https://api.example.com/v1",
      "http://target.local/x",
    ]);
    expect(extractCommandUrls("ls && curl https://a.example.com && echo done")).toEqual(["https://a.example.com"]);
  });
  it("strips trailing sentence punctuation and continuations", () => {
    expect(extractCommandUrls("echo see https://example.com/a.")).toEqual(["https://example.com/a"]);
    expect(extractCommandUrls("curl https://example.com/a?x=1&y=2\\")).toEqual(["https://example.com/a?x=1&y=2"]);
  });
  it("de-dupes and returns nothing for URL-free commands", () => {
    expect(extractCommandUrls("curl https://a.com/x && curl https://a.com/x")).toEqual(["https://a.com/x"]);
    expect(extractCommandUrls("ls -la && git status")).toEqual([]);
  });
  it("ignores scheme-less git ssh URLs (normalizeUrl refuses them upstream)", () => {
    expect(extractCommandUrls("git clone git@github.com:o/r.git")).toEqual([]);
  });
});

describe("session-allowed hosts", () => {
  it("rememberHost admits the same host for the session only where granted", () => {
    clearSessionAllowed();
    expect(isSessionAllowed("https://newhost.com/a")).toBe(false);
    rememberHost("https://newhost.com/a");
    expect(isSessionAllowed("https://newhost.com/b")).toBe(true);
    expect(isSessionAllowed("https://other.newhost.com/b")).toBe(false);
    clearSessionAllowed();
    expect(isSessionAllowed("https://newhost.com/a")).toBe(false);
  });
});

describe("urlRefusalReason", () => {
  it("names the remedy and forbids route-hunting", () => {
    const r = urlRefusalReason("https://x.com", "webfetch", "ask");
    expect(r).toContain("url-whitelist.json");
    expect(r).toContain("Do NOT retry");
  });

  it("says asking was impossible only when asking was impossible", () => {
    // The bug this pins: a sub-coder (no UI) received the block-mode sentence
    // and reported "This session runs in LITTLE_CODER_URL_GATE=block mode" — a
    // setting the user never set — so the model went looking for a knob that
    // does not exist instead of reporting that nobody could be asked.
    const noUi = urlRefusalReason("https://x.com", "webfetch", "no-ui");
    expect(noUi).not.toContain("LITTLE_CODER_URL_GATE");
    expect(noUi).toContain("no interface to ask the user");

    const blocked = urlRefusalReason("https://x.com", "webfetch", "block");
    expect(blocked).toContain("LITTLE_CODER_URL_GATE=block");
    expect(blocked).not.toContain("no interface to ask the user");
  });

  it("states the command/URL split for shell tools, because accept-all allows commands", () => {
    expect(urlRefusalReason("https://x.com", "bash", "ask")).toContain("NOT the shell command");
    expect(urlRefusalReason("https://x.com", "webfetch", "ask")).not.toContain("NOT the shell command");
  });
});
