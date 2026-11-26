// Web-search provider layer for the websearch tool.
//
// Two providers behind one interface:
//   duckduckgo (default) — the original html.duckduckgo.com scrape, moved
//     verbatim from index.ts so default behavior is byte-identical.
//   searxng             — a self-hosted SearXNG instance (open-source
//     metasearch) reached through its JSON API: one GET, no new deps.
//
// Selection is one env var, LITTLE_CODER_WEB_PROVIDER=duckduckgo|searxng,
// resolved HERE and nowhere else — the websearch tool AND the url-gate both
// call resolveSearchProvider, so the gate can never judge a different endpoint
// than the tool actually dials (the hole the url-gate branch exists to close).
//
// Error contract (deliberate, mirrors upstream #139's fail-loud posture):
// an unknown provider value throws; provider=searxng with SEARXNG_URL unset
// or malformed throws naming the variable; an unreachable instance errors
// naming the URL. There is NEVER a silent fallback to DuckDuckGo — a search
// that quietly changed backend (and quality) is the #130 failure shape.

/** The env var that selects the provider (same name #139 introduced). */
export const PROVIDER_ENV = "LITTLE_CODER_WEB_PROVIDER";
/** The env var naming the SearXNG instance base URL. */
export const SEARXNG_URL_ENV = "SEARXNG_URL";

export type SearchProvider = "duckduckgo" | "searxng";

/** The fixed endpoint the duckduckgo provider dials — also the endpoint
 *  url-gate judges for websearch when the provider is the default. */
export const DDG_SEARCH_URL = "https://html.duckduckgo.com/html/";

/** Resolve the provider from an env map (process.env by default). Pure and
 *  total except for the fail-loud throw on an unknown value: an unset or
 *  empty value is the documented default, a typo is a misconfiguration and
 *  must surface, not silently pick a backend. */
export function resolveSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const raw = (env[PROVIDER_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "duckduckgo") return "duckduckgo";
  if (raw === "searxng") return "searxng";
  throw new Error(
    `${PROVIDER_ENV}="${env[PROVIDER_ENV]}" is not a known web search provider — expected "duckduckgo" or "searxng".`,
  );
}

/** The base URL of the configured SearXNG instance, without a trailing slash.
 *  Throws naming SEARXNG_URL when it is unset or not a usable http(s) URL —
 *  the tool error and the gate refusal both carry this message. */
export function searxngBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[SEARXNG_URL_ENV] ?? "").trim();
  if (!raw) {
    throw new Error(
      `${PROVIDER_ENV}=searxng but ${SEARXNG_URL_ENV} is not set — set ${SEARXNG_URL_ENV}=http://host:port ` +
        `to the SearXNG instance to use (and add that host to url-whitelist.json).`,
    );
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${SEARXNG_URL_ENV}="${raw}" is not a valid URL — expected http://host:port or https://host.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${SEARXNG_URL_ENV}="${raw}" must be an http(s) URL.`);
  }
  return raw.replace(/\/+$/, "");
}

/** The URL url-gate must judge for a websearch call under the current env:
 *  the DDG endpoint, the configured SearXNG /search endpoint, or — when the
 *  provider config itself is broken — a fail-closed message string that is
 *  not a valid URL, so the gate refuses rather than letting the call through
 *  ungated. One source of truth with the tool: both resolve through here. */
export function websearchEndpointUrl(env: NodeJS.ProcessEnv = process.env): string {
  let provider: SearchProvider;
  try {
    provider = resolveSearchProvider(env);
  } catch (e) {
    return `websearch: ${(e as Error).message}`;
  }
  if (provider === "duckduckgo") return DDG_SEARCH_URL;
  try {
    return `${searxngBaseUrl(env)}/search`;
  } catch (e) {
    return `websearch: ${(e as Error).message}`;
  }
}

interface FetchOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Combine the caller's (pi's) AbortSignal with the per-call ceiling. The
// controller + clearTimeout shape keeps the timer from holding the event loop
// open after the call settles. Exported so webfetch in index.ts combines the
// same way — one cancellation shape for every network tool here.
export function webSignal(signal?: AbortSignal, timeoutMs = 30_000): { signal: AbortSignal; done: () => void } {
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

/** One SearXNG result as it matters to us. The live JSON carries more
 *  (engine, engines, score, category, parsed_url, optional publishedDate…) —
 *  only these three are read; extra fields are ignored by design so a SearXNG
 *  bump cannot break the mapping. */
interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

/** Render SearXNG's `results[]` into the tool's Markdown shape — the same
 *  `**title**\nurl\nsnippet` layout (top 8) the DDG path produces. JSON fields
 *  are typed unknown on purpose: only strings are read, anything else (a
 *  nested object from some future SearXNG field) renders empty rather than
 *  `[object Object]`. */
export function renderSearxngResults(results: readonly SearxngResult[]): string {
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const rows = results
    .filter((r) => text(r?.url) !== "")
    .slice(0, 8)
    .map((r) => `**${text(r.title) || "(untitled)"}**\n${text(r.url)}\n${text(r.content)}`);
  if (rows.length === 0) return "No results found";
  return rows.join("\n\n");
}

/** Search a self-hosted SearXNG instance via its JSON API (one GET).
 *  Errors name the instance URL; never falls back to another provider. */
export async function searxngSearch(query: string, opts: FetchOpts & { baseUrl: string }): Promise<string> {
  const { baseUrl, signal, timeoutMs = 30_000 } = opts;
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const web = webSignal(signal, timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "little-coder/0.1" },
      redirect: "follow",
      signal: web.signal,
    });
    if (!res.ok) {
      throw new Error(`SearXNG at ${baseUrl} returned HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(await res.text());
    } catch {
      throw new Error(
        `SearXNG at ${baseUrl} did not return JSON — is the JSON API enabled? ` +
          `settings.yml needs search.formats to include "json".`,
      );
    }
    const results = (doc as any)?.results;
    if (!Array.isArray(results)) {
      // A reachable instance that answers without `results[]` is usually the
      // limiter or a disabled JSON format answering with an HTML page or an
      // error object — say which instance, never fall back.
      throw new Error(
        `SearXNG at ${baseUrl} returned no results array — check that the JSON format is enabled ` +
          `and the limiter is off for this instance (settings.yml: search.formats, server.limiter).`,
      );
    }
    return renderSearxngResults(results);
  } catch (e) {
    if ((e as Error)?.name === "AbortError" && !signal?.aborted) {
      throw new Error(`SearXNG at ${baseUrl} did not answer within ${timeoutMs / 1000}s.`);
    }
    throw e;
  } finally {
    web.done();
  }
}

/** The original DuckDuckGo html scrape, moved verbatim from index.ts. */
export async function duckduckgoSearch(query: string, opts: FetchOpts = {}): Promise<string> {
  const { signal, timeoutMs = 30_000 } = opts;
  const web = webSignal(signal, timeoutMs);
  try {
    const url = `${DDG_SEARCH_URL}?q=${encodeURIComponent(query)}`;
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
    if (titles.length === 0) return "No results found";
    return titles.map((t, i) => `**${t.title}**\n${t.link}\n${snippets[i] ?? ""}`).join("\n\n");
  } finally {
    web.done();
  }
}
