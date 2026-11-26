import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { globFiles, renderGlobOutcome } from "./glob.ts";
import { extractContent } from "./extract.ts";
import { duckduckgoSearch, resolveSearchProvider, searxngBaseUrl, searxngSearch, webSignal } from "./search.ts";
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

// webSignal (shared with search.ts): combines pi's execute(id, args, signal,
// update, ctx) AbortSignal with the tool's own 30 s ceiling so BOTH cancel the
// fetch — Ctrl-C / a pi-side cancel stops an in-flight request, and the
// ceiling still bounds a hung server when nobody cancels.

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
    description:
      "Fetch a URL and return its extracted main text (nav/footer/script chrome dropped; " +
      "<main>/<article> preferred; <pre> kept). With `prompt`, the passages whose wording matches it, " +
      "in document order. Capped at 25K chars.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      prompt: Type.Optional(Type.String({ description: "What to extract — passages matching it are ranked first" })),
    }),
    async execute(_id, { url, prompt }, signal?: AbortSignal) {
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
        // Block-level extraction instead of the old three-regex tag strip:
        // chrome blocks dropped, <main>/<article> preferred, <pre> kept, and
        // `prompt` used as the objective (the #139 "objective" half, local and
        // deterministic). Provider-independent, so it applies to every fetch.
        if (ct.includes("html")) text = extractContent(text, { objective: prompt });
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
    description:
      "Search the web and return the top ~8 results as Markdown. Provider: DuckDuckGo by default; " +
      "LITTLE_CODER_WEB_PROVIDER=searxng + SEARXNG_URL routes through a self-hosted SearXNG instance.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_id, { query }, signal?: AbortSignal) {
      try {
        // Provider resolution is fail-loud (unknown value throws naming the
        // env var; searxng without a usable SEARXNG_URL throws naming it) and
        // NEVER falls back to another backend — the same module url-gate uses,
        // so the gate and the tool dial the same endpoint.
        const provider = resolveSearchProvider();
        const text =
          provider === "searxng"
            ? await searxngSearch(query, { baseUrl: searxngBaseUrl(), signal })
            : await duckduckgoSearch(query, { signal });
        return { content: [{ type: "text", text }], details: {} };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });
}
