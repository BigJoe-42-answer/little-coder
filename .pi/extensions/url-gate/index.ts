import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tryCtx } from "../_shared/safe-ctx.ts";
import { SHELL_TOOLS } from "../_shared/shell-write.ts";
import {
  getUrlGateMode,
  extractTargetUrl,
  extractCommandUrls,
  loadWhitelistIfChanged,
  isUrlAllowed,
  isSessionAllowed,
  rememberHost,
  urlRefusalReason,
  type WhitelistState,
} from "./gate.ts";
// URL allowlist gate. Mirrors permission-gate's shape: a tool_call hook that
// blocks with an instructive reason, plus ctx.ui.confirm to ask the user when
// a URL is not on the allowlist.
//
// Outstanding work, known gaps, and the do-not-add host list: docs/url-gate-todo.md.
//
//   ONE whitelist file: ${XDG_CONFIG_HOME:-~/.config}/little-coder/url-whitelist.json
//   (LITTLE_CODER_URL_WHITELIST=/path is the only override)
//   LITTLE_CODER_URL_GATE=ask|block|off   (default ask)
//   LITTLE_CODER_URL_GATE_BROWSER=main-frame|all|off  (default main-frame;
//   the browser's own request-level layer — see .pi/extensions/browser/)
//
// ask   : non-listed URL -> prompt the user; deny -> block, allow -> the host
//         is remembered for the rest of the session.
// block : non-listed URL -> blocked outright (headless/RPC default when no UI).
// off   : no gate.
//
// Covered surfaces: webfetch (input.url), websearch (the endpoint its
// configured provider actually dials — DDG by default, SEARXNG_URL when
// LITTLE_CODER_WEB_PROVIDER=searxng; resolved by the same search.ts the tool
// uses), BrowserNavigate (input.url), pi's built-in browser tools if present,
// webfetch's redirect hops (checked inside extra-tools via gate.isUrlAllowed),
// every http(s) URL named inside a shell command, and — below the tool layer,
// in the browser itself — the destinations the model never named: clicks,
// form posts, meta/JS redirects, iframes, redirect hops, back-navigations.
//
// The shell case is the load-bearing one for this deployment. It runs with
// LITTLE_CODER_PERMISSION_MODE=accept-all, so permission-gate lets every
// command through — which would make a URL allowlist a joke, because
// `curl https://off-list.host` is just a command. So the two gates split by
// what they judge, not by which tool ran: the COMMAND is free (the user's
// choice), the URL is checked (also the user's choice). A denied URL blocks the
// command that carries it, and the refusal says so explicitly, because the
// model has otherwise been told the shell is unrestricted and would otherwise
// re-run the identical fetch through wget.
//
// Residual, stated rather than hidden: a script that makes its own HTTP calls
// (python3 crawler.py), package-manager traffic whose URL the model never
// typed, and a shell fetcher's own redirect hops (curl -L). Those were never
// visible at the tool layer and need a network-layer boundary (proxy/firewall).
// In the browser, main-frame mode leaves subresources alone on purpose, and a
// WebSocket to an off-list host is not a navigation, so it passes; `all` mode
// closes the subresource half of that at the cost of breaking pages that need
// off-list CSS/images/XHR.

const BROWSER_URL_TOOLS = new Set(["BrowserNavigate", "browser_navigate", "navigate", "browser goto"]);

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const mode = getUrlGateMode();
    if (mode === "off") return;

    const toolName = String((event as any).toolName ?? "");
    const input: any = (event as any).input ?? (event as any).args;

    // Which URL(s) this call touches. Shell tools are judged on the URLs their
    // command text names; everything else on its url parameter.
    const urls: string[] = [];
    const direct =
      extractTargetUrl(toolName, input) ??
      // Pi's own browser tools (not the little-coder browser extension) also
      // carry url-shaped inputs; gate any tool that names a URL and is
      // browser-shaped so the gate cannot be dodged by tool-name drift.
      ((BROWSER_URL_TOOLS.has(toolName) || /browser/i.test(toolName)) && typeof input?.url === "string"
        ? input.url.trim()
        : null);
    if (direct) urls.push(direct);
    if (SHELL_TOOLS.has(toolName) && typeof input?.command === "string") {
      for (const u of extractCommandUrls(input.command)) if (!urls.includes(u)) urls.push(u);
    }
    if (urls.length === 0) return;

    // Redirect hops of an already-gated fetch are re-checked at tool level
    // (extra-tools webfetch calls gate.isUrlAllowed per hop), so the initial
    // URL here is the whole job for this hook.
    const state = loadWhitelistIfChanged(current);
    if (state.loadError) {
      tryCtx(() => ctx.ui.notify(`url-gate: ${state.loadError}`, "warning"), undefined);
    }
    current = state;

    for (const url of urls) {
      if (isUrlAllowed(url, state.patterns) || isSessionAllowed(url)) continue;

      // Two different reasons for refusing silently, and they must not share a
      // sentence: `block` is a mode the user chose, no-UI means the prompt was
      // impossible (sub-coder, RPC/headless) and the gate failed closed.
      const noUI = !tryCtx(() => !!(ctx as any).hasUI, false);
      if (mode === "block" || noUI) {
        return { block: true, reason: urlRefusalReason(url, toolName, mode === "block" ? "block" : "no-ui") };
      }

      // ask: put the decision in front of the user. The prompt text names the
      // whitelist file so the "yes" path is actionable beyond one click. For a
      // shell call it also shows the command, so "yes" is an informed answer
      // about a command the user has (by choice) chosen to allow freely.
      const shown = SHELL_TOOLS.has(toolName) ? `${toolName} command:\n${input.command}\n` : `${toolName}: ${url}\n`;
      // (ctx as any).ui: the typed ExtensionUI surface declares confirm as
      // sync; the TUI returns a Promise, hence the await below either way.
      const confirmed = await tryCtx(
        () =>
          (ctx as any).ui.confirm(
            `URL not on the allowlist\n\n${shown}\nHost: ${safeHost(url)}`,
            `Allow access to ${safeHost(url)}? (approved hosts stay allowed for this session; add them permanently to ${state.path})`,
          ),
        false,
      );
      if (!confirmed) {
        return { block: true, reason: urlRefusalReason(url, toolName, "ask") };
      }
      rememberHost(url);
    }
  });
}

let current: WhitelistState | null = null;

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}
