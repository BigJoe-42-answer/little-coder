import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extractContent } from "./extract.ts";

// Extraction fixtures per docs/web-search-open-plan.md §4: nav/footer/script
// stripped, <article> preferred, <pre> preserved, objective ranking picks the
// right paragraph, CJK text survives. Plus one tool-level check through the
// REAL registered webfetch against a local server — no external network.

describe("extractContent — chrome removal", () => {
  const page = `<!doctype html><html><head><style>.x{BODY-STYLE-LEAK}</style>
<script>var SCRIPT_LEAK = "yes";</script></head>
<body>
<header>HEADER-MARK sign in</header>
<nav>NAV-MARK home about</nav>
<aside>ASIDE-MARK related links</aside>
<form>FORM-MARK subscribe</form>
<svg><text>SVG-MARK</text></svg>
<main>
  <h1>Real Title</h1>
  <p>The actual article paragraph with MAIN-CONTENT.</p>
  <p>Second paragraph continues the point.</p>
</main>
<footer>FOOTER-MARK copyright 2026</footer>
<noscript>NOSCRIPT-MARK</noscript>
</body></html>`;

  const out = extractContent(page);

  it("drops script/style/nav/header/footer/aside/form/svg/noscript blocks", () => {
    for (const leak of [
      "SCRIPT_LEAK",
      "BODY-STYLE-LEAK",
      "NAV-MARK",
      "HEADER-MARK",
      "FOOTER-MARK",
      "ASIDE-MARK",
      "FORM-MARK",
      "SVG-MARK",
      "NOSCRIPT-MARK",
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  it("keeps the main content, in document order", () => {
    expect(out).toContain("Real Title");
    expect(out).toContain("The actual article paragraph with MAIN-CONTENT.");
    expect(out.indexOf("Real Title")).toBeLessThan(out.indexOf("Second paragraph"));
  });
});

describe("extractContent — container preference", () => {
  it("prefers <main> over everything else", () => {
    const out = extractContent(
      `<html><body><div>OUTSIDE-MARK junk</div><main><p>INSIDE-MAIN</p></main><div>MORE-JUNK</div></body></html>`,
    );
    expect(out).toBe("INSIDE-MAIN");
  });

  it("falls back to <article> when there is no <main>", () => {
    const out = extractContent(
      `<html><body><div>OUTSIDE-MARK</div><article><p>INSIDE-ARTICLE</p></article></body></html>`,
    );
    expect(out).toBe("INSIDE-ARTICLE");
  });

  it("no container means the whole (chrome-stripped) body", () => {
    const out = extractContent(`<html><body><p>LOOSE-PARAGRAPH</p><footer>FOOTER-MARK</footer></body></html>`);
    expect(out).toContain("LOOSE-PARAGRAPH");
    expect(out).not.toContain("FOOTER-MARK");
  });
});

describe("extractContent — <pre> preservation", () => {
  it("keeps code blocks with newlines and indentation intact", () => {
    const out = extractContent(
      `<html><body><main><p>Before.</p><pre><code>function f() {\n    return 42;  // indented\n}</code></pre><p>After.</p></main></body></html>`,
    );
    expect(out).toContain("function f() {\n    return 42;  // indented\n}");
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
  });

  it("decodes entities inside <pre> but not angle-bracket tags", () => {
    const out = extractContent(`<pre>a &amp;&amp; b &lt; c</pre>`);
    expect(out).toBe("a && b < c");
  });
});

describe("extractContent — objective ranking", () => {
  const doc = `<html><body><article>
    <p>Intro about cooking pasta with garlic.</p>
    <p>Boil water and salt it well.</p>
    <p>The quantum tunneling effect lets particles cross classically forbidden barriers.</p>
    <p>Serving suggestion: parmesan on top.</p>
    <p>Quantum tunneling rates fall off exponentially with barrier width.</p>
  </article></body></html>`;

  it("returns the passages matching the objective, in document order", () => {
    const out = extractContent(doc, { objective: "quantum tunneling barrier" });
    expect(out).toContain("quantum tunneling effect lets particles");
    expect(out).toContain("tunneling rates fall off exponentially");
    expect(out).not.toContain("cooking pasta");
    expect(out).not.toContain("parmesan");
    // Document order, not score order: the effect paragraph precedes the rates one.
    expect(out.indexOf("lets particles")).toBeLessThan(out.indexOf("fall off exponentially"));
  });

  it("an objective matching nothing falls back to document order, not empty", () => {
    const out = extractContent(doc, { objective: "xylophone kazoo" });
    expect(out).toContain("cooking pasta");
    expect(out).toContain("parmesan");
  });

  it("without an objective, every content line survives in document order", () => {
    const out = extractContent(doc);
    for (const frag of ["cooking pasta", "Boil water", "quantum tunneling effect", "parmesan", "fall off"]) {
      expect(out).toContain(frag);
    }
  });

  it("CJK objectives rank CJK text (per-character tokens)", () => {
    const cjk = `<article>
      <p>今天天气很好，适合出去散步。</p>
      <p>量子隧穿效应允许粒子穿过势垒。</p>
      <p>菜谱需要大蒜和橄榄油。</p>
    </article>`;
    const out = extractContent(cjk, { objective: "量子隧穿" });
    expect(out).toContain("量子隧穿效应");
    expect(out).not.toContain("菜谱");
  });

  it("CJK text survives plain extraction intact", () => {
    const out = extractContent(`<main><p>中文内容测试：熵与信息。</p></main>`);
    expect(out).toBe("中文内容测试：熵与信息。");
  });
});

describe("extractContent — entities, cap, junk", () => {
  it("decodes common entities", () => {
    const out = extractContent(`<p>Fish &amp; Chips &lt;3 &quot;quoted&quot; &#39;apos&#39; &#8212; &nbsp;done</p>`);
    expect(out).toBe('Fish & Chips <3 "quoted" \'apos\' —  done'.replace("  done", " done"));
  });

  it("honours the character cap", () => {
    const big = `<main>${"<p>word ".repeat(500)}</main>`;
    const out = extractContent(big, { cap: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it("empty or tag-free input does not throw", () => {
    expect(extractContent("")).toBe("");
    expect(extractContent("just words")).toBe("just words");
  });
});

// ── tool-level: the REAL webfetch, local server, no nav residue ──────────

type Tool = { execute: (id: string, input: any, signal?: AbortSignal) => Promise<any> };
let server: ReturnType<typeof createServer>;
let port = 0;
const tools = new Map<string, Tool>();

const CHROME_PAGE = `<!doctype html><html><head><title>t</title><style>.a{NAV-CSS-LEAK}</style></head>
<body><nav>NAV-MARK-TOOL home</nav><header>HEADER-MARK-TOOL</header>
<main><h1>ToolTitle</h1>
<p>Alpha paragraph about batteries and their capacity ratings.</p>
<p>Beta paragraph about unrelated gardening tips.</p>
<p>Gamma paragraph on battery chemistry and cell voltage.</p></main>
<footer>FOOTER-MARK-TOOL</footer></body></html>`;

function handler(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url || "/").split("?")[0];
  if (path === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(CHROME_PAGE);
    return;
  }
  if (path === "/plain") {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("plain text stays verbatim NAV-MARK-TOOL");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("no route");
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
  await new Promise<void>((r) => server.close(() => r()));
});

async function callWebfetch(input: any) {
  const tool = tools.get("webfetch");
  if (!tool) throw new Error("webfetch was never registered");
  const res = await tool.execute("t-webfetch", input);
  return { text: (res?.content?.[0]?.text ?? "") as string, isError: !!res?.isError };
}

describe("webfetch tool — extraction wired in", () => {
  it("output contains no nav/footer/script residue", async () => {
    const r = await callWebfetch({ url: `http://127.0.0.1:${port}/page` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("ToolTitle");
    expect(r.text).toContain("Alpha paragraph");
    for (const leak of ["NAV-MARK-TOOL", "HEADER-MARK-TOOL", "FOOTER-MARK-TOOL", "NAV-CSS-LEAK"]) {
      expect(r.text).not.toContain(leak);
    }
  });

  it("prompt returns the battery passages, not the gardening one", async () => {
    const r = await callWebfetch({
      url: `http://127.0.0.1:${port}/page`,
      prompt: "battery capacity voltage",
    });
    expect(r.text).toContain("batteries and their capacity ratings");
    expect(r.text).toContain("battery chemistry and cell voltage");
    expect(r.text).not.toContain("gardening");
  });

  it("non-HTML content is untouched by the extractor", async () => {
    const r = await callWebfetch({ url: `http://127.0.0.1:${port}/plain` });
    expect(r.text).toBe("plain text stays verbatim NAV-MARK-TOOL");
  });
});
