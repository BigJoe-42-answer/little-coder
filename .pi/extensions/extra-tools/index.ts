import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { globFiles, renderGlobOutcome } from "./glob.ts";
import { isUrlAllowed, loadWhitelist, whitelistPath, isSessionAllowed } from "../url-gate/gate.ts";

// webfetch follows redirects, so gating only the URL the model named would
// leak: example.com/redirect can land the fetch on an off-allowlist host.
// The fetch below therefore walks the redirect chain manually and re-checks
// every hop through url-gate's matcher — the same module the tool_call hook
// uses, so hook and tool can never disagree. If url-gate is absent (a pruned
// deployment) the module would not resolve at all, which is why the import is
// static. A MISSING whitelist file, by contrast, fails CLOSED: with one
// canonical location (see gate.whitelistPath) an absent file is a
// misconfiguration, and the redirect chain is precisely where an off-list host
// would otherwise slip through unexamined.
async function checkRedirectHop(nextUrl: string): Promise<string | null> {
  if (isSessionAllowed(nextUrl)) return null;
  const st = loadWhitelist(whitelistPath());
  if (st.loadError) {
    return (
      `webfetch stopped at a redirect and the URL whitelist could not be read (${st.loadError}). ` +
      `Create that file to use the URL allowlist. Do not work around this by re-requesting the URL elsewhere.`
    );
  }
  if (isUrlAllowed(nextUrl, st.patterns)) return null;
  return (
    `webfetch stopped at a redirect: ${nextUrl} is not in the URL whitelist. ` +
    `Do not re-request it through another tool. Tell the user which host the redirect targeted — ` +
    `they can add it to url-whitelist.json or approve it when the url-gate prompt appears.`
  );
}

// Ports of tools.py::_glob, _webfetch, _websearch. Pi ships its own grep/find,
// so those are not re-registered here.

// pi calls execute(id, args, signal, update, ctx); the signal is undefined for
// callers that pass none. Combine it with the tool's own 30 s ceiling so BOTH
// cancel the fetch: Ctrl-C / a pi-side cancel aborts an in-flight request
// instead of letting it run to completion, and the ceiling still bounds a hung
// server when nobody cancels. The controller + clearTimeout shape (rather than
// AbortSignal.timeout) keeps the timer unref'd-by-construction: a finished
// fetch must not hold the event loop open for the rest of the 30 s.
function webSignal(signal?: AbortSignal, timeoutMs = 30_000): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener(
        "abort",
        () => controller.abort(),
        { once: true },
      );
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export default function (pi: ExtensionAPI) {
  // ── glob ────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "glob",
    label: "Glob",
    description:
      "Find files matching a glob pattern. Returns a sorted list of matching paths (up to 100). " +
      "Common dependency/build/cache dirs (node_modules, .git, dist, …) are skipped, and the walk " +
      "is bounded — for a focused search, pass a `path` rather than globbing a whole home directory.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern e.g. **/*.py" }),
      path: Type.Optional(Type.String({ description: "Base directory (default: cwd)" })),
    }),
    async execute(_id, { pattern, path }) {
      try {
        const base = path || process.cwd();
        // Bounded walk: prunes heavy dirs and caps total entries scanned so a
        // recursive glob from a huge root can't exhaust the process heap.
        const outcome = await globFiles(pattern, { base });
        return {
          content: [{ type: "text", text: renderGlobOutcome(outcome) }],
          details: {},
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // ── webfetch ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "webfetch",
    label: "WebFetch",
    description: "Fetch a URL and return its text content (HTML stripped). Capped at 25K chars.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      prompt: Type.Optional(Type.String({ description: "Hint for what to extract (informational)" })),
    }),
    async execute(_id, { url }, signal?: AbortSignal) {
      const web = webSignal(signal);
      try {
        let res: Response | null = null;
        let current = url;
        for (let hop = 0; ; hop++) {
          res = await fetch(current, {
            headers: { "User-Agent": "little-coder/0.1" },
            redirect: "manual",
            signal: web.signal,
          });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc || hop >= 5) break;
            const next = new URL(loc, current).toString();
            const refusal = await checkRedirectHop(next);
            if (refusal) {
              return {
                content: [{ type: "text", text: `Error: ${refusal}` }],
                details: {},
                isError: true,
              };
            }
            current = next;
            continue;
          }
          break;
        }
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Error: HTTP ${res.status} ${res.statusText}` }],
            details: {},
            isError: true,
          };
        }
        const ct = res.headers.get("content-type") || "";
        let text = await res.text();
        if (ct.includes("html")) {
          text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
          text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
          text = text.replace(/<[^>]+>/g, " ");
          text = text.replace(/\s+/g, " ").trim();
        }
        if (text.length > 25_000) text = text.slice(0, 25_000);
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      } finally {
        web.done();
      }
    },
  });

  // ── websearch ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "websearch",
    label: "WebSearch",
    description: "Search the web via DuckDuckGo and return the top ~8 results as Markdown.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, { query }, signal?: AbortSignal) {
      const web = webSignal(signal);
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
          redirect: "follow",
          signal: web.signal,
        });
        const body = await res.text();
        const titleRe = /class="result__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/g;
        const titles: Array<{ link: string; title: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = titleRe.exec(body)) && titles.length < 8) {
          titles.push({ link: m[1], title: m[2].replace(/<[^>]+>/g, "").trim() });
        }
        const snippets: string[] = [];
        while ((m = snippetRe.exec(body)) && snippets.length < 8) {
          snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
        }
        if (titles.length === 0) {
          return {
            content: [{ type: "text", text: "No results found" }],
            details: {},
          };
        }
        const out = titles
          .map((t, i) => `**${t.title}**\n${t.link}\n${snippets[i] ?? ""}`)
          .join("\n\n");
        return { content: [{ type: "text", text: out }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      } finally {
        web.done();
      }
    },
  });
}
