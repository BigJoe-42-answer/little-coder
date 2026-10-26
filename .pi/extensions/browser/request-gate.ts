// Request-level URL gate for the browser extension.
//
// WHY THIS EXISTS
// The url-gate tool_call hook can only judge a URL the model NAMED. Inside the
// browser most destinations are never named: a BrowserClick on a link, a form
// submit, a JS or meta redirect, a BrowserBack re-navigating a history entry,
// an <iframe src>, and every hop of a server-side redirect chain all pick the
// destination without one appearing in a tool input. So an approved page plus
// one click reached any host on the internet — the allowlist stopped at the
// edge of the browser.
//
// WHY CDP Fetch AND NOT page.route()
// page.route() is the obvious primitive and it is the wrong one, twice over:
//   1. request.abort() only works on an intercepted request, so a passive
//      page.on("request") listener aborts nothing while looking healthy.
//   2. page.route() treats a request and its redirects as ONE unit: the
//      handler fires for the original request and Chromium follows the Location
//      on its own. Verified live — with a route installed, an on-list
//      /redirect302 reached an off-list target, and page.url() reported it with
//      status 200. Any on-list page could therefore launder any off-list
//      destination one hop away, which is exactly what a link shortener or a
//      "redirecting…" interstitial is.
//      Walking the chain inside the handler and route.fulfill()-ing the result
//      does block the hops, but it moves every document through Node and
//      breaks real pages: the browser shows the target's bytes under the
//      ORIGINAL url, so every relative link resolves against the wrong base,
//      and content-encoding must be stripped or the body is decoded twice.
//      Observed live, both.
// Chromium's DevTools protocol Fetch.requestPaused fires for EACH hop, and the
// browser keeps doing its own fetching, so nothing about page fidelity changes.
// This extension launches chromium, so CDP is available; if the CDP session
// cannot be opened, it falls back to page.route(), which still covers the
// initial URL of clicks, submits, meta/JS redirects and back-navigations (but
// not their hops) — a weaker layer is worth having when the strong one is gone.
//
// The decision itself lives in url-gate/gate.ts (browserRequestAllowed) so the
// hook, webfetch's hop-check and the browser cannot disagree about one host.

import type { BrowserSession } from "./index.ts";

type GateModule = typeof import("../url-gate/gate.ts");

export async function installRequestGate(page: any, sess: BrowserSession, forPopup = false): Promise<void> {
  let gate: GateModule | null = null;
  try {
    gate = await import("../url-gate/gate.ts");
  } catch {
    return; // url-gate is not part of this install: zero interception
  }
  if (!gate || gate.getBrowserGateMode() === "off") return;
  const g = gate;

  const blocked = sess.blockedByGate;
  const noteBlocked = (url: string) => {
    if (!blocked.includes(url)) blocked.push(url);
  };

  // Backstop, not the main line of defence: popups are normally folded back
  // into this page before they can open (see ensureSession's addInitScript),
  // but a target that appears anyway gets gated as soon as it is attached.
  // Attaching is a race Chromium usually wins — measured live, a popup to an
  // off-list host reached the server before a CDP session could open, which is
  // why folding, not attaching, is what the test pins down.
  if (!forPopup && sess.context && typeof sess.context.on === "function") {
    sess.context.on("page", (popup: any) => {
      if (popup !== page) void installRequestGate(popup, sess, true).catch(() => {});
    });
  }

  // An unreadable whitelist blocks every navigation, and
  // net::ERR_BLOCKED_BY_CLIENT says nothing about which file to fix. Name it.
  const state = g.currentWhitelistState();
  if (state.loadError) noteBlocked(`whitelist unavailable: ${state.loadError}`);

  const verdict = (url: string, isNavigation: boolean): boolean => {
    const mode = g.getBrowserGateMode();
    if (mode === "off") return true;
    // Non-http(s) schemes (about:blank, data:, blob:) are not network
    // destinations; this layer judges destinations. A data: URL the MODEL types
    // is already refused at the tool layer.
    if (!/^https?:/i.test(url)) return true;
    return g.browserRequestAllowed(mode, url, isNavigation, g.currentWhitelistPatterns());
  };

  try {
    const cdp = await sess.context.newCDPSession(page);
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*" }],
      handleAuthRequests: false,
    });
    sess.gateLayer = "cdp";

    cdp.on("Fetch.requestPaused", async (ev: any) => {
      const url: string = ev?.request?.url ?? "";
      // resourceType "Document" = a navigation into a frame: goto, link click,
      // form post, meta/JS redirect, back-navigation, a redirect HOP, an
      // <iframe src>. Everything else is a subresource, which main-frame mode
      // deliberately leaves alone — the user approved a page, not a host
      // boundary around its assets.
      const isNavigation = ev?.resourceType === "Document";
      const allow = verdict(url, isNavigation);
      if (!allow) noteBlocked(url);
      try {
        if (allow) {
          await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
        } else {
          await cdp.send("Fetch.failRequest", {
            requestId: ev.requestId,
            errorReason: "BlockedByClient",
          });
        }
      } catch {
        // The request is already gone (navigation superseded). Nothing to do;
        // the page itself moves on.
      }
    });
    return;
  } catch {
    // No CDP session — fall back to the weaker layer rather than to nothing.
  }

  try {
    page.route("**/*", async (route: any) => {
      const req = route.request();
      let isNavigation = true;
      try {
        isNavigation = req.isNavigationRequest();
      } catch {
        isNavigation = true; // cannot tell → judge it, don't wave it
      }
      const url = req.url();
      if (!verdict(url, isNavigation)) {
        noteBlocked(url);
        void route.abort("blockedbyclient").catch(() => {});
        return;
      }
      void route.continue().catch(() => {});
    });
    sess.gateLayer = "route";
  } catch {
    sess.gateLayer = "none";
    noteBlocked("request-level gate inactive: no CDP session and no route support");
  }
}
