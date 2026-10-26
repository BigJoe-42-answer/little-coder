import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { installRequestGate } from "./request-gate.ts";

// Port of local/tools/browser.py. Playwright-powered Browser* tools with
// per-session lazy Page launch, chunked Readability extract, history stack,
// graceful degradation when Playwright isn't installed.
//
// URL-gate integration: ensureSession() calls installRequestGate() (see
// ./request-gate.ts for why it is CDP Fetch and not page.route), which refuses
// off-allowlist requests and decides through url-gate/gate.ts so the hook, the
// webfetch hop-check and the browser cannot disagree. It covers the
// destinations the tool_call hook CANNOT see because they never appear in a
// tool input: a BrowserClick on an off-list link, JS/meta redirects, form
// submits, redirect hops, iframes, and BrowserBack re-navigating a history
// entry. Mode: LITTLE_CODER_URL_GATE_BROWSER=main-frame (default) | all | off.
// main-frame gates navigations and their hops and lets subresources through
// (pages stay usable); all also gates subresources, which kills trackers but
// also breaks pages needing off-list CSS/images/XHR — choose it on purpose.
// off disables request-level gating (and so does LITTLE_CODER_URL_GATE=off).
// If the url-gate extension is absent the gate no-ops — the browser extension
// never hard-depends on a sibling extension.
//
// To enable: `npm install playwright && npx playwright install chromium`.
// Without those the tools register but return a clear error.

const CHUNK_SIZE = 2048;

// Inlined "Readability-lite": remove heavy structural nodes and collapse
// whitespace. Passed to page.evaluate as a real function (not a string) —
// Playwright silently returns undefined when given a string function literal
// like `"() => {...}"` because it evaluates to a function *value*, not an
// invocation. `document` is only defined in the page context.
function readablePageText(): string {
  const doc = (globalThis as any).document;
  const clone = doc.body.cloneNode(true);
  const drop = clone.querySelectorAll(
    "script, style, noscript, iframe, nav, header, footer, aside, form",
  );
  drop.forEach((n: any) => n.remove());
  const text = (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}
function fallbackPageText(): string {
  const doc = (globalThis as any).document;
  return doc.body ? doc.body.innerText : "";
}

export interface BrowserSession {
  pw: any;
  browser: any;
  context: any;
  page: any;
  history: string[];
  extractCache: Map<string, string>;
  error: string;
  /** Requests the URL gate aborted since the last tool call. Surfaced in the
   *  tool result: a blocked link click leaves the page exactly where it was,
   *  and "clicked. url=<unchanged>" otherwise reads as if it worked. */
  blockedByGate: string[];
  /** Which interception layer is in force: "cdp" (sees every redirect
   *  hop) | "route" (Playwright fallback, initial URLs only) | "none". */
  gateLayer?: string;
}

const sessions = new Map<string, BrowserSession>();

function sessionKey(): string {
  return process.env.LITTLE_CODER_SESSION_ID || "default";
}

function headful(): boolean {
  return !!process.env.BROWSER_HEADFUL;
}

async function ensureSession(): Promise<BrowserSession> {
  const key = sessionKey();
  let sess = sessions.get(key);
  if (!sess) {
    sess = {
      pw: null, browser: null, context: null, page: null,
      history: [], extractCache: new Map(), error: "", blockedByGate: [],
    };
    sessions.set(key, sess);
  }
  if (sess.page || sess.error) return sess;
  try {
    // Optional runtime dep; cast avoids requiring @types/playwright at build time
    const playwright: any = await import("playwright" as any);
    const browser = await playwright.chromium.launch({ headless: !headful() });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (little-coder research agent)",
      viewport: { width: 1280, height: 900 },
      // A page's own service worker can fetch on the page's behalf, and those
      // requests are the ones page-level interception sees worst (Playwright
      // documents exactly this blind spot for route(); CDP Fetch sees them no
      // better). A research agent gains nothing from a site's service worker,
      // so block them and the hole closes.
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    // A popup is a NEW target the gate has not attached to, and attaching is a
    // race the gate loses (verified: the popup's own request was already in
    // flight before a CDP session could open). The model cannot read a popup
    // either — there are no tab tools — so a popup is ungated network traffic
    // for no benefit. Fold it back into the gated page instead: target=_blank
    // becomes _self and window.open is a no-op, so the destination goes through
    // this page's gate and the content lands where BrowserExtract can see it.
    try {
      await context.addInitScript(() => {
        (window as any).open = () => null;
        document.addEventListener(
          "click",
          (ev: any) => {
            const a = ev.target?.closest?.("a[target=_blank]");
            if (a) a.target = "_self";
          },
          true,
        );
      });
    } catch {
      // addInitScript failing only restores the old popup behaviour.
    }
    sess.pw = playwright;
    sess.browser = browser;
    sess.context = context;
    sess.page = page;
    // After the fields above: the gate opens a CDP session through
    // sess.context, and installing it first silently fell back to the weaker
    // page.route() layer — which the tests then passed for the wrong reason.
    await installRequestGate(page, sess);
  } catch (e: any) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module 'playwright'/.test(e?.message ?? "")) {
      sess.error = "Playwright is not installed. Run: npm install playwright && npx playwright install chromium";
    } else {
      sess.error = `Browser launch failed: ${e?.message ?? e}`;
    }
  }
  return sess;
}


/** Which request-level gate the live session has, or undefined if no session.
 *  Exported because the CDP layer and the page.route() fallback enforce
 *  different things — CDP also blocks redirect hops — and a silent downgrade
 *  from one to the other would otherwise be invisible from outside. */
export function browserGateLayer(sessionId?: string): string | undefined {
  return sessions.get(sessionId ?? sessionKey())?.gateLayer;
}

export async function resetBrowserSession(sessionId?: string): Promise<void> {
  const key = sessionId ?? sessionKey();
  const sess = sessions.get(key);
  if (!sess) return;
  sessions.delete(key);
  try { if (sess.page) await sess.page.close(); } catch {}
  try { if (sess.context) await sess.context.close(); } catch {}
  try { if (sess.browser) await sess.browser.close(); } catch {}
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** Drain the gate's blocked-request log into a warning line for the model.
 *  The gate cannot prompt from inside the browser (the ask already happened at
 *  tool level for the URL the model named), so a silently-dropped navigation
 *  is the one outcome the model must never be left to guess about. */
function gateNote(sess: BrowserSession): string {
  if (!sess.blockedByGate.length) return "";
  const urls = sess.blockedByGate.splice(0).map((u) => `  blocked (not on the URL whitelist): ${u}`).join("\n");
  return (
    `\n${urls}\nThe page did NOT navigate there and cannot: the URL whitelist refused it. `
    + `Do not retry the same link, an off-list mirror, or a cached copy — tell the user which host `
    + `was refused and that they can add it to url-whitelist.json.`
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    await resetBrowserSession();
  });

  // ── BrowserNavigate ──────────────────────────────────────────────────
  pi.registerTool({
    name: "BrowserNavigate",
    label: "BrowserNavigate",
    description: "Navigate the browser to a URL. Must start with http:// or https://.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
    }),
    async execute(_id, { url }) {
      const u = (url ?? "").trim();
      if (!u) return errorResult("Error: url is required");
      if (!u.startsWith("http://") && !u.startsWith("https://")) {
        return errorResult("Error: url must start with http:// or https://");
      }
      const sess = await ensureSession();
      if (sess.error) return errorResult(`Error: ${sess.error}`);
      try {
        const resp = await sess.page.goto(u, { waitUntil: "domcontentloaded" });
        sess.history.push(sess.page.url());
        sess.extractCache.clear();
        const status = resp ? resp.status() : "?";
        const title = await sess.page.title();
        return textResult(`[status=${status}] ${sess.page.url()}\ntitle: ${title}`);
      } catch (e: any) {
        return errorResult(`Error navigating to ${u}: ${e?.message ?? e}${gateNote(sess)}`);
      }
    },
  });

  // ── BrowserClick ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "BrowserClick",
    label: "BrowserClick",
    description: "Click an element by CSS selector, or by ARIA role (with optional accessible name).",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector" })),
      role: Type.Optional(Type.String({ description: "ARIA role (e.g. button, link)" })),
      name: Type.Optional(Type.String({ description: "Accessible name for role" })),
    }),
    async execute(_id, { selector, role, name }) {
      const sel = (selector ?? "").trim();
      const r = (role ?? "").trim();
      const n = (name ?? "").trim();
      if (!sel && !r) {
        return errorResult("Error: provide either 'selector' or 'role' (+ optional 'name')");
      }
      const sess = await ensureSession();
      if (sess.error) return errorResult(`Error: ${sess.error}`);
      try {
        const loc = r
          ? (n ? sess.page.getByRole(r, { name: n }) : sess.page.getByRole(r))
          : sess.page.locator(sel);
        await loc.first().click();
        await sess.page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
        sess.history.push(sess.page.url());
        sess.extractCache.clear();
        return textResult(`clicked. url=${sess.page.url()}${gateNote(sess)}`);
      } catch (e: any) {
        return errorResult(`Error clicking: ${e?.message ?? e}`);
      }
    },
  });

  // ── BrowserType ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "BrowserType",
    label: "BrowserType",
    description: "Fill a form field by selector. Optionally submit by pressing Enter.",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector of the input" }),
      text: Type.String({ description: "Text to type" }),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing" })),
    }),
    async execute(_id, { selector, text, submit }) {
      const sel = (selector ?? "").trim();
      const t = text ?? "";
      if (!sel) return errorResult("Error: selector is required");
      const sess = await ensureSession();
      if (sess.error) return errorResult(`Error: ${sess.error}`);
      try {
        await sess.page.fill(sel, t);
        if (submit) {
          await sess.page.press(sel, "Enter");
          await sess.page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
          sess.history.push(sess.page.url());
          sess.extractCache.clear();
        }
        return textResult(`typed ${t.length} chars into ${sel}${submit ? " + Enter" : ""}${gateNote(sess)}`);
      } catch (e: any) {
        return errorResult(`Error typing: ${e?.message ?? e}`);
      }
    },
  });

  // ── BrowserScroll ────────────────────────────────────────────────────
  pi.registerTool({
    name: "BrowserScroll",
    label: "BrowserScroll",
    description: "Scroll the current page up or down by a pixel amount (default 800px down).",
    parameters: Type.Object({
      direction: Type.Optional(Type.String({ description: "up or down" })),
      amount: Type.Optional(Type.Integer({ description: "Pixels (default 800)" })),
    }),
    async execute(_id, { direction, amount }) {
      const dir = ((direction ?? "down") as string).toLowerCase();
      const amt = typeof amount === "number" ? amount : 800;
      const sess = await ensureSession();
      if (sess.error) return errorResult(`Error: ${sess.error}`);
      const dy = dir === "down" ? amt : -amt;
      try {
        await sess.page.evaluate(`window.scrollBy(0, ${dy})`);
        return textResult(`scrolled ${dir} by ${amt}px`);
      } catch (e: any) {
        return errorResult(`Error scrolling: ${e?.message ?? e}`);
      }
    },
  });

  // ── BrowserExtract ───────────────────────────────────────────────────
  pi.registerTool({
    name: "BrowserExtract",
    label: "BrowserExtract",
    description:
      "Extract the current page's readable text. Returns a 2KB chunk with cursor+has_more " +
      "so one page can't swamp context. Call repeatedly with the last 'next=' cursor.",
    parameters: Type.Object({
      cursor: Type.Optional(Type.String({ description: "Byte offset to start from (default 0)" })),
    }),
    async execute(_id, { cursor }) {
      const sess = await ensureSession();
      if (sess.error) return errorResult(`Error: ${sess.error}`);
      try {
        if (!sess.extractCache.has("full")) {
          let text: string = await sess.page.evaluate(readablePageText);
          if (!text) {
            text = await sess.page.evaluate(fallbackPageText);
          }
          sess.extractCache.set("full", text ?? "");
        }
        const full = sess.extractCache.get("full") ?? "";
        const startRaw = parseInt((cursor ?? "0") as string, 10);
        const start = Number.isFinite(startRaw) ? startRaw : 0;
        if (start < 0 || start >= full.length) {
          return textResult(`[cursor=${start} past end (length=${full.length})]`);
        }
        const end = Math.min(start + CHUNK_SIZE, full.length);
        const chunk = full.slice(start, end);
        const hasMore = end < full.length;
        const footerBits = [
          `cursor=${start}`,
          `next=${hasMore ? end : "null"}`,
          `total=${full.length}`,
        ];
        if (hasMore) footerBits.push("has_more=true");
        return textResult(`${chunk}\n[${footerBits.join(" ")}]`);
      } catch (e: any) {
        return errorResult(`Error extracting: ${e?.message ?? e}`);
      }
    },
  });

  // ── BrowserBack ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "BrowserBack",
    label: "BrowserBack",
    description: "Navigate back in the browser's history.",
    parameters: Type.Object({}),
    async execute() {
      const sess = await ensureSession();
      if (sess.error) return errorResult(`Error: ${sess.error}`);
      try {
        await sess.page.goBack({ waitUntil: "domcontentloaded" });
        sess.extractCache.clear();
        return textResult(`back. url=${sess.page.url()}${gateNote(sess)}`);
      } catch (e: any) {
        return errorResult(`Error going back: ${e?.message ?? e}`);
      }
    },
  });

  // ── BrowserHistory ───────────────────────────────────────────────────
  pi.registerTool({
    name: "BrowserHistory",
    label: "BrowserHistory",
    description: "List the last 20 URLs visited in this session.",
    parameters: Type.Object({}),
    async execute() {
      const sess = await ensureSession();
      if (sess.error) return errorResult(`Error: ${sess.error}`);
      if (sess.history.length === 0) return textResult("(no pages visited yet)");
      const lines = sess.history.slice(-20).map((u, i) => `${i + 1}. ${u}`);
      return textResult(lines.join("\n"));
    },
  });
}
