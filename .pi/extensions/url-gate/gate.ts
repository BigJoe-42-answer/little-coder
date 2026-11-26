// Pure logic for the url-gate extension: which tool calls carry a URL, and
// whether that URL is on the user's allowlist. Kept free of pi/ctx so it is
// unit-testable exactly like permission-gate's isSafeBash, and importable by
// the webfetch tool itself for its redirect-hop re-check (defense in depth:
// the tool_call hook AND the tool agree through this one module).
//
// Whitelist file, exactly one: ${XDG_CONFIG_HOME:-~/.config}/little-coder/
//   url-whitelist.json  (or LITTLE_CODER_URL_WHITELIST=/path/to/file.json)
// Pattern forms (case-insensitive host, path is exact/prefix):
//   "example.com"        host only, any path        -> every scheme's URL on that exact host
//   "*.example.com"      apex + any subdomain
//   "example.com/docs"   host + path prefix
//   "https://x.com/a"    full URL: scheme must match, host+path as prefix rule
// Non-matching URLs are not silently blocked: the extension asks the user.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { websearchEndpointUrl } from "../extra-tools/search.ts";

/** Tools whose input carries a directly-requested URL.
 *
 *  BrowserBack is deliberately NOT here: its target is resolved by the browser
 *  from its own history stack, so there is no URL in the tool input for a
 *  tool_call hook to judge. Same for BrowserClick/BrowserType. Those
 *  destinations are covered one layer down, by the request-level gate in
 *  .pi/extensions/browser/request-gate.ts (see browserRequestAllowed below) —
 *  which is also why this gate had to move below the tool-input layer at all. */
export const URL_TOOLS: ReadonlySet<string> = new Set([
  "webfetch",
  "BrowserNavigate",
]);

/** Tools that reach the network but do not name a URL in their input. The
 *  fixed endpoint each one hits is gated under that host, so a deployment that
 *  does not want search at all simply leaves duckduckgo.com off the list.
 *
 *  websearch is deliberately NOT in this map: its endpoint depends on
 *  LITTLE_CODER_WEB_PROVIDER (+ SEARXNG_URL), and a hardcoded DDG entry would
 *  gate a searxng search against a host it never dials — the exact "gate and
 *  tool disagree" hole this branch exists to close. extractTargetUrl resolves
 *  it through the SAME search.ts the tool uses (one source of truth). */
export const FIXED_ENDPOINTS: Readonly<Record<string, string>> = {};

/** The URL a tool call targets, or null when the tool carries none. */
export function extractTargetUrl(toolName: string, input: any): string | null {
  if (typeof toolName === "string" && toolName === "websearch") {
    // Provider-resolved, never hardcoded. When the provider config itself is
    // broken (unknown value, or searxng without a usable SEARXNG_URL) this
    // returns a fail-closed message string that is not a valid URL: the hook
    // then refuses rather than letting the call through ungated, and the
    // message names the variable and url-whitelist.json.
    return websearchEndpointUrl();
  }
  if (typeof toolName === "string" && FIXED_ENDPOINTS[toolName]) {
    return FIXED_ENDPOINTS[toolName];
  }
  const url = input?.url;
  if (typeof url !== "string" || url.trim() === "") return null;
  if (!URL_TOOLS.has(toolName)) return null;
  return url.trim();
}

/** Every http(s) URL named anywhere in a shell command.
 *
 *  Why this exists: `LITTLE_CODER_PERMISSION_MODE=accept-all` frees the shell
 *  gate on purpose (the user wants commands allowed, not audited), and that
 *  otherwise lets `curl https://off-list.example` walk straight past a URL
 *  allowlist whose whole job is that URL. So the split is:
 *    permission-gate judges the COMMAND — off, by user choice.
 *    url-gate judges the URL inside it — always on.
 *  Scanning any command for a URL (rather than keeping a binary list) is the
 *  deliberate choice: a list of "fetch-capable" binaries (`curl`, `wget`,
 *  `aria2c`, `git`, `pip`, `npm`, `httpie`, …) is long, endlessly incomplete,
 *  and every miss is a bypass. Echoing a URL costs the user one prompt they
 *  wave through; missing a fetcher costs the whole policy.
 *
 *  What it still cannot see, stated plainly: a script that makes its own HTTP
 *  calls (`python3 crawler.py`), package-manager traffic whose URL the model
 *  never typed, and a fetcher's own redirect hops (`curl -L`). Those need a
 *  network-layer boundary (proxy/firewall), not a tool-layer one. */
export function extractCommandUrls(command: string): string[] {
  const out: string[] = [];
  // `&` stays INSIDE the character class: `?a=1&b=2` is the common case, and a
  // glued-on background operator (`curl url&`) still yields the right host, so
  // over-capturing one char in the path costs nothing while excluding `&` cuts
  // real URLs in half. The genuinely structural shell characters (`|`, `;`,
  // spaces, quotes, redirections) do end a URL.
  for (const m of command.matchAll(/https?:\/\/[^\s'"`|;<>()${}\\[\]]+/g)) {
    // Trim trailing punctuation that ended the sentence/argument rather than
    // the URL, and shell escapes that trail it (`\` line-continuation).
    const cleaned = m[0].replace(/[\\]*[.,;:!?'")\]]+$/, "");
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/** Canonical form used for both the pattern's host part and the live URL.
 *  Returns null for anything that is not a plain http(s) URL — file:, data:,
 *  javascript:, scheme-less junk all funnel into a single refusal upstream. */
export function normalizeUrl(raw: string): { host: string; path: string; scheme: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let host = u.hostname.toLowerCase();
  // Strip the default port so "x.com:80" matches "x.com".
  if (u.port && !((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443"))) {
    host = `${host}:${u.port}`;
  }
  let path = decodeURIComponentSafe(u.pathname);
  if (path === "" || path === "/") path = "/";
  return { host, path, scheme: u.protocol.slice(0, -1) };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Match one normalized URL against one pattern. */
export function matchPattern(url: { host: string; path: string; scheme: string }, patternRaw: string): boolean {
  const pattern = patternRaw.trim().toLowerCase();
  if (!pattern || pattern.startsWith("#")) return false;

  // Full-URL pattern: scheme must match exactly, then host(+path) prefix rule.
  let wantScheme: string | null = null;
  let rest = pattern;
  const schemeMatch = /^(https?):\/\//.exec(pattern);
  if (schemeMatch) {
    wantScheme = schemeMatch[1];
    rest = pattern.slice(schemeMatch[0].length);
  }
  if (wantScheme && wantScheme !== url.scheme) return false;

  // Split host part from path part at the first '/'.
  const slash = rest.indexOf("/");
  const hostPat = (slash === -1 ? rest : rest.slice(0, slash)).replace(/\/+$/, "");
  const pathPat = slash === -1 ? "" : rest.slice(slash);

  if (!hostPat) return false;

  let hostOk: boolean;
  if (hostPat.startsWith("*.")) {
    const base = hostPat.slice(2);
    hostOk = url.host === base || url.host.endsWith(`.${base}`);
  } else {
    hostOk = url.host === hostPat;
  }
  if (!hostOk) return false;

  if (!pathPat || pathPat === "/") return true;
  // Path prefix rule, anchored on path segments: "/docs" admits "/docs" and
  // "/docs/x" but not "/docsy".
  if (url.path === pathPat) return true;
  if (pathPat.endsWith("/")) return url.path.startsWith(pathPat);
  return url.path.startsWith(`${pathPat}/`);
}

export function isUrlAllowed(rawUrl: string, patterns: readonly string[]): boolean {
  const norm = normalizeUrl(rawUrl);
  if (!norm) return false;
  return patterns.some((p) => matchPattern(norm, p));
}

// ── whitelist file loading (parse once, hot-reload on mtime change) ───────

/** ONE file, ONE location. `$LITTLE_CODER_URL_WHITELIST` if set, otherwise
 *  `${XDG_CONFIG_HOME:-~/.config}/little-coder/url-whitelist.json` — the same
 *  directory little-coder already uses for models.json and user extensions.
 *
 *  Two things this deliberately is not:
 *   - **cwd-relative.** The cwd is whatever directory the agent happened to be
 *     started in, so a cwd lookup quietly means "no whitelist in this one"
 *     (that is exactly how the first deployment ended up prompting for every
 *     URL, including ones on the list).
 *   - **a search path.** Multiple candidate locations means several files that
 *     can disagree about which hosts are allowed, with no visible answer. One
 *     path, one file, and the warning/prompt always names it.
 *
 *  If the file is absent the gate fails CLOSED (empty list → every URL asks)
 *  and the loadError names the path to create. */
export function whitelistPath(): string {
  const env = process.env.LITTLE_CODER_URL_WHITELIST?.trim();
  if (env) return env;
  const cfgHome = process.env.XDG_CONFIG_HOME?.trim() || join(process.env.HOME || homedir(), ".config");
  return join(cfgHome, "little-coder", "url-whitelist.json");
}

export function parseWhitelist(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  // Accept both { allowed: [...] } and a bare [...] for hand-editing ease.
  const list = Array.isArray(doc) ? doc : (doc as any)?.allowed;
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
}

export interface WhitelistState {
  path: string;
  patterns: string[];
  /** Human-readable load problem, surfaced to the user rather than crashing. */
  loadError: string | null;
  /** File mtime at parse time, kept so the next check has something to compare
   *  AGAINST. The first version of this compared statSync(path) with
   *  statSync(current.path) — the same path twice, hence always equal — so the
   *  file was parsed once per session and editing it did nothing until restart.
   *  -1 when the file does not exist. */
  mtimeMs: number;
}

export function loadWhitelist(path: string): WhitelistState {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { path, patterns: [], loadError: `whitelist file not found: ${path}`, mtimeMs: -1 };
  }
  try {
    const patterns = parseWhitelist(readFileSync(path, "utf8"));
    return { path, patterns, loadError: null, mtimeMs };
  } catch (e: any) {
    return { path, patterns: [], loadError: `whitelist unreadable (${e?.message ?? e})`, mtimeMs };
  }
}

export function loadWhitelistIfChanged(current: WhitelistState | null): WhitelistState {
  const path = whitelistPath();
  if (current && current.path === path && current.loadError === null) {
    try {
      if (statSync(path).mtimeMs === current.mtimeMs) return current;
    } catch {
      // fall through to a reload, which will set loadError
    }
  }
  return loadWhitelist(path);
}

/** The gate's own cached view of the whitelist, for callers that are not the
 *  tool_call hook — the browser's request listener, and anything else that
 *  needs "the patterns right now" without wanting to manage a WhitelistState.
 *  Same ONE file and same mtime-based hot-reload as the hook, so a mid-session
 *  edit reaches the browser and the hook at the same moment. Returns [] (fail
 *  closed for the browser listener) when the file is missing or unreadable. */
let cachedState: WhitelistState | null = null;

export function currentWhitelistState(): WhitelistState {
  cachedState = loadWhitelistIfChanged(cachedState);
  return cachedState;
}

export function currentWhitelistPatterns(): string[] {
  return currentWhitelistState().patterns;
}

export type UrlGateMode = "ask" | "block" | "off";

/** Why an unlisted URL is being refused without a prompt. Distinct from the
 *  mode because the two need different sentences: a `block` session was
 *  configured that way, a no-UI session (sub-coder, RPC/headless) could not ask
 *  at all — and blaming the env var for the latter sends the model hunting for a
 *  setting the user never set. */
export type RefusalCause = "ask" | "block" | "no-ui";

export function getUrlGateMode(): UrlGateMode {
  const v = process.env.LITTLE_CODER_URL_GATE;
  if (v === "off" || v === "block") return v;
  return "ask";
}

// ── browser request gating ──────────────────────────────────────────────
// The tool_call hook can only judge a URL the model NAMED. Inside the browser
// most destinations are never named: a BrowserClick on a link, a JS or meta
// redirect, a form submit, or a BrowserBack re-navigating a history entry all
// pick the URL without one ever appearing in a tool input. That gap used to be
// the whole story; the browser extension now installs a `page.on("request")`
// listener (see .pi/extensions/browser/index.ts) and asks this function. The
// decision lives HERE so hook, webfetch-hop-check and browser agree through
// one module — the same reason extra-tools imports isUrlAllowed.
//
// LITTLE_CODER_URL_GATE_BROWSER:
//   main-frame (default) — gate navigations into a frame (including an iframe's
//                          own document, redirect hops, and back-navigations),
//                          let subresources through.
//   all                  — also gate subresources: kills trackers and ads, but
//                          also kills the CSS/images/XHR a real site needs,
//                          so some pages render broken or stick at
//                          domcontentloaded. Choose it on purpose.
//   off                  — no request-level gating; only the hook's named-URL
//                          checks apply.
// The request listener cannot prompt — the ask/block/no-UI decision already
// happened at tool level for the URL the model named — so the ONLY question
// here is "is this destination on the list (or a host the user approved this
// session)". Off-list navigations abort; there is no in-browser retry loop,
// and the refusal text stays short because the page, not the model, sees it.

export type BrowserGateMode = "main-frame" | "all" | "off";

export function getBrowserGateMode(): BrowserGateMode {
  // LITTLE_CODER_URL_GATE=off turns the whole gate off, browser included:
  // leaving the browser half on would be surprising, and the half that stayed
  // on could not ask the user anything.
  if (getUrlGateMode() === "off") return "off";
  const v = process.env.LITTLE_CODER_URL_GATE_BROWSER;
  if (v === "off" || v === "all") return v;
  return "main-frame";
}

/* @param isNavigation — true when the request is the document request that
 * replaces what the browser is showing (goto, link click, form post, meta/JS
 * redirect, back-navigation, a redirect hop, an <iframe src>). In main-frame
 * mode a subresource — image, CSS, XHR — is NOT gated: the user approved a
 * page, not a host boundary around its assets. */
export function browserRequestAllowed(
  mode: BrowserGateMode,
  url: string,
  isNavigation: boolean,
  patterns: readonly string[],
): boolean {
  if (mode === "off") return true;
  if (mode === "main-frame" && !isNavigation) return true;
  return isUrlAllowed(url, patterns) || isSessionAllowed(url);
}

// ── session-allowed hosts ("yes, allow it" answers from the user) ───────
// Module-level like the browser extension's `sessions` map: lives for the
// agent process, never persisted, so an approval never silently outlives the
// session it was given in.

const sessionAllowedHosts = new Set<string>();

export function rememberHost(rawUrl: string): void {
  const norm = normalizeUrl(rawUrl);
  if (norm) sessionAllowedHosts.add(norm.host);
}

export function isSessionAllowed(rawUrl: string): boolean {
  const norm = normalizeUrl(rawUrl);
  return !!norm && sessionAllowedHosts.has(norm.host);
}

export function clearSessionAllowed(): void {
  sessionAllowedHosts.clear();
}

/** Hosts the user approved this session — for display/audit only. */
export function sessionAllowedHostList(): string[] {
  return [...sessionAllowedHosts];
}

/** Refusal text for a URL the user denied, or that could not be asked about. */
export function urlRefusalReason(url: string, toolName: string, cause: RefusalCause): string {
  // Under LITTLE_CODER_PERMISSION_MODE=accept-all the model has been told the
  // shell is free. A refusal on a SHELL command therefore reads as a
  // contradiction unless the message states the split — the command is allowed,
  // the URL inside it is what is gated — or it re-runs the same fetch with
  // wget, aria2c or git, which is exactly the hunt this text exists to stop.
  const shellSplit =
    /^(bash|Bash|ShellSession|ShellStart|Shell)$/.test(toolName)
      ? `\nThis is NOT the shell command being refused: this deployment allows shell commands freely. The URL inside it is the thing the user asked to control, so swap the host or ask them to add it — do not re-run the same fetch with wget, curl, git, aria2c or a script.\n`
      : "\n";
  return (
    `url allowlist: "${url}" is not in the user's URL whitelist (${toolName} refused).` +
    shellSplit +
    `Do NOT retry the same page through another tool, another host mirror, or webfetch of a cached copy — ` +
    `that defeats a limit the user set on purpose and wastes your budget.\n` +
    `Pick a source that IS whitelisted, or tell the user this URL was declined and that they can add the host ` +
    `to url-whitelist.json. Then continue with the rest of the task.` +
    (cause === "block"
      ? `\nThis session runs with LITTLE_CODER_URL_GATE=block, so non-whitelisted URLs are refused without asking.`
      : cause === "no-ui"
        ? `\nNothing was refused because of a setting: this session has no interface to ask the user in (a sub-coder, or an RPC/headless run), so the prompt could not be shown and the URL was refused instead. Only adding the host to url-whitelist.json changes that.`
        : "")
  );
}
