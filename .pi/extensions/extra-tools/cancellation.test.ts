import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Cancellation plumbing: pi passes execute(id, args, signal, update, ctx), and
// both web tools must thread that AbortSignal into their fetch so a Ctrl-C or
// a pi-side cancel actually stops the request — not just the tool's return.
//
// Hermetic by construction (the url-gate-browser.test.ts pattern): a local
// http server on 127.0.0.1, the REAL registered tools invoked the way pi
// invokes them, and assertions made on the SERVER's own log — the proof that
// an aborted fetch stopped reading is the server observing the socket close
// BEFORE it ever got to write the second chunk, not just "the tool printed an
// error". No external network, ever.

type Tool = { execute: (id: string, input: any, signal?: AbortSignal) => Promise<any> };

let server: ReturnType<typeof createServer>;
let port = 0;
const tools = new Map<string, Tool>();

// Per-route server observations, reset in beforeEach.
let saw: { slowHit: boolean; streamClosedBeforeChunk2: boolean; streamWroteChunk2: boolean; okHits: number };

function handler(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url || "/").split("?")[0];
  if (path === "/slow") {
    // Answers only after the test has certainly aborted.
    saw.slowHit = true;
    res.writeHead(200, { "content-type": "text/html" });
    setTimeout(() => res.end("<h1>TOO-LATE</h1>"), 5_000).unref?.();
    return;
  }
  if (path === "/stream") {
    // Chunked body: first chunk now, second only after 300 ms — and only if
    // the client is still there. If the socket closed first, the abort
    // genuinely stopped the read, which is what the test asserts.
    res.writeHead(200, { "content-type": "text/html", "transfer-encoding": "chunked" });
    res.write("<!doctype html><html><body><h1>CHUNK1");
    req.on("close", () => {
      if (!saw.streamWroteChunk2) saw.streamClosedBeforeChunk2 = true;
    });
    setTimeout(() => {
      if (req.destroyed || res.destroyed) return;
      saw.streamWroteChunk2 = true;
      res.end("-CHUNK2</h1></body></html>");
    }, 300).unref?.();
    return;
  }
  if (path === "/ok") {
    saw.okHits++;
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end("<!doctype html><html><body><h1>OK-PAGE</h1></body></html>");
    return;
  }
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<h1>404</h1>");
}

async function call(name: string, input: any, signal?: AbortSignal) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} was never registered`);
  const res = await tool.execute(`t-${name}`, input, signal);
  return { text: (res?.content?.[0]?.text ?? "") as string, isError: !!res?.isError };
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;

  // Register the real extension: pi's registerTool surface stubbed only enough
  // to capture the tool handlers, which are then executed unchanged.
  const { default: registerExtra } = await import("./index.ts");
  const pi: any = { on: () => {}, registerTool: (t: any) => tools.set(t.name, t) };
  registerExtra(pi);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  saw = { slowHit: false, streamClosedBeforeChunk2: false, streamWroteChunk2: false, okHits: 0 };
});

const abortAfter = (ms: number) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  t.unref?.();
  return c.signal;
};

describe("webfetch cancellation", () => {
  it("returns an abort error promptly when the signal fires mid-request", async () => {
    const started = Date.now();
    const r = await call("webfetch", { url: `http://127.0.0.1:${port}/slow` }, abortAfter(150));
    const elapsed = Date.now() - started;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/abort/i);
    // The server would only answer at 5 s; returning in well under that proves
    // the fetch was cancelled rather than awaited.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("stops reading the body: the server sees the socket close before its next chunk", async () => {
    const r = await call("webfetch", { url: `http://127.0.0.1:${port}/stream` }, abortAfter(120));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/abort/i);
    // Give the server past its 300 ms chunk-2 deadline: if the abort had not
    // torn the connection, chunk 2 would have been written and recorded.
    await new Promise((r2) => setTimeout(r2, 500));
    expect(saw.streamClosedBeforeChunk2).toBe(true);
    expect(saw.streamWroteChunk2).toBe(false);
  });

  it("an already-aborted signal never reaches the server at all", async () => {
    const c = new AbortController();
    c.abort();
    const r = await call("webfetch", { url: `http://127.0.0.1:${port}/slow` }, c.signal);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/abort/i);
    expect(saw.slowHit).toBe(false);
  });

  it("no signal means the ordinary fetch path is unchanged", async () => {
    const r = await call("webfetch", { url: `http://127.0.0.1:${port}/ok` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("OK-PAGE");
    expect(saw.okHits).toBe(1);
  });
});

describe("websearch cancellation", () => {
  it("an already-aborted signal fails with an abort error, no network read", async () => {
    // The DDG endpoint is fixed, so the hermetic half of this is the
    // pre-aborted signal: fetch rejects before any socket is opened. The
    // mid-flight half is covered for the searxng provider in search.test.ts,
    // where the endpoint is a local fixture.
    const c = new AbortController();
    c.abort();
    const r = await call("websearch", { query: "anything" }, c.signal);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/abort/i);
  });
});
