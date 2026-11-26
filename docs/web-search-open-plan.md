# Plan: an open-source equivalent of upstream PR #139 (better web search + extraction), zero new dependencies

**Status: plan only — nothing implemented.** For a future session. Ground rules
taken from the request: **minimal dependencies** (target: **zero new npm
deps**, lockfile untouched), **open source or new code only** (no proprietary
search SaaS), and it must fit this fork's existing web posture (url-gate
allowlist, `--ignore-scripts`, LAN-first servers).

## 1. What #139 is, and what is worth replicating

Upstream [#139](https://github.com/itayinbarr/little-coder/pull/139) adds
`LITTLE_CODER_WEB_PROVIDER=parallel`, which routes `websearch`/`webfetch` to
Parallel's hosted MCP endpoint (`https://search.parallel.ai/mcp`) using
`@modelcontextprotocol/sdk` (the +1218-line lockfile delta). User-visible
capabilities:

1. search returns **titles + URLs + text excerpts** (richer than link-only);
2. fetch returns **extracted main content**, optionally steered by an
   `objective` (the existing `prompt` param), instead of tag-stripped soup;
3. both honor **pi's AbortSignal** (cancellation) with a 30 s ceiling;
4. the setting **reaches research sub-coders** (env inheritance).

What we deliberately do **not** replicate: the Parallel endpoint itself
(proprietary SaaS; it receives queries plus a conversation-correlation ID —
the fork's compensating control is the url-gate allowlist, and #139 adds an
un-gated third-party destination by design), and the MCP client dependency
(a full client+transport for one JSON call).

## 2. Design

### 2.1 Search backend: self-hosted SearXNG (open source), DuckDuckGo stays the default

- New env: `LITTLE_CODER_WEB_PROVIDER=duckduckgo|searxng` (same variable name
  #139 introduced, different values), plus `SEARXNG_URL=http://host:8888`.
  Default stays `duckduckgo` — **zero behavior change unless opted in**.
- New module `.pi/extensions/extra-tools/search.ts`:
  - `resolveSearchProvider(env)` — pure, throws on an unknown value (same
    fail-loud posture as #139's `webProvider()`).
  - `searxngSearch(query, { baseUrl, signal, timeoutMs = 30_000 })` — plain
    `fetch(`${base}/search?q=…&format=json`)`, map `results[]`
    (`title`, `url`, `content`) to the existing Markdown shape
    (`**title**\nurl\nsnippet`, top ~8). No new deps — SearXNG's JSON API is
    one GET.
  - DuckDuckGo's current scrape stays as-is behind the same interface.
- Why SearXNG: it is the only realistic open-source web-search backend
  (metasearch over Google/Bing/Mojeek/etc., AGPL, single container). Public
  instances mostly disable `format=json` and rate-limit, so **self-hosting is
  the primary path** — and this machine already runs LAN-first servers
  (strata, llama.cpp), so a local SearXNG fits the topology. A whitelisted
  public instance works too if the user prefers it.
- Error contract: provider `searxng` with `SEARXNG_URL` unset → tool error
  naming the variable; unreachable instance → error naming the URL. Never a
  silent fall back to DDG (a search that quietly changed backend and quality
  is the #130 failure shape again).

### 2.2 Extraction: new-code block extractor for `webfetch` (no DOM, no deps)

- Today `webfetch` strips tags with three regexes → nav/footer soup. Full
  Mozilla Readability needs a DOM (jsdom = new dep) or a per-call headless
  chromium (heavy on a laptop) — both rejected.
- New module `.pi/extensions/extra-tools/extract.ts` (new code, ~120 lines):
  drop `script/style/nav/header/footer/aside/form/noscript/svg` blocks,
  prefer `<main>`/`<article>` when present, split remaining block elements
  into paragraphs, keep `<pre>`/`<code>` content intact, collapse whitespace.
- `prompt`/objective behavior (the #139 "objective" half): when `prompt` is
  given, score paragraphs by token overlap with the objective (lowercased
  word set, no stemmer) and return the top chunks in document order within
  the existing 25 K cap; when absent, current head-truncation behavior.
  Naive vs Parallel's hosted ranking — but local, private, deterministic,
  testable. JS-heavy pages keep the existing answer: the Browser tools
  (playwright + inlined Readability) already do DOM-grade extraction.

### 2.3 Cancellation plumbing (adopt #139's good part, applies to BOTH providers)

- `execute(_id, args, signal)` — thread pi's `AbortSignal` into both tools'
  `fetch` (replacing the bare `setTimeout`-only controller; combine:
  `AbortSignal.any([signal, timeout])` on Node 22+). Small, self-contained,
  worth landing even if nothing else in this plan does.

### 2.4 url-gate: judge the endpoint the provider ACTUALLY calls

- `url-gate/gate.ts` hardcodes `websearch: "https://html.duckduckgo.com/html/"`
  as the fixed endpoint. With a provider switch that becomes a lie: a
  `searxng` search would be gated against DDG while actually dialing
  `SEARXNG_URL` — the exact "gate and tool disagree" hole the url-gate
  branch exists to close.
- Fix: `extractTargetUrl("websearch")` resolves the same
  `resolveSearchProvider(env)` + `SEARXNG_URL` the tool uses (import from
  `extra-tools/search.ts` — one source of truth). An unset/invalid
  `SEARXNG_URL` fails closed with a message naming the host and
  `url-whitelist.json`, per the gate's existing refusal style.

### 2.5 Sub-coder reach

- Sub-coders inherit the launcher env, so `LITTLE_CODER_WEB_PROVIDER` /
  `SEARXNG_URL` reach them for free. Pin that with one test (child session
  sees the same provider resolution), mirroring #139's claim.

## 3. Files

| File | Change |
|---|---|
| `.pi/extensions/extra-tools/search.ts` | NEW: provider resolution + searxng/DDG search |
| `.pi/extensions/extra-tools/extract.ts` | NEW: block extractor + objective ranking |
| `.pi/extensions/extra-tools/index.ts` | websearch delegates to search.ts; webfetch uses extract.ts; signal plumbing |
| `.pi/extensions/url-gate/gate.ts` | websearch endpoint resolved from provider, not hardcoded |
| `.pi/extensions/url-gate/gate.test.ts` | searxng endpoint cases |
| `.pi/extensions/extra-tools/search.test.ts` | NEW: hermetic provider/search tests |
| `.pi/extensions/extra-tools/extract.test.ts` | NEW: extraction fixtures (nav/footer, code blocks, CJK) |
| `README.md` (fork section) | env vars + SearXNG deploy + whitelist entry |
| `CHANGELOG.md` | `[Unreleased]` Added entry |

**No changes to `package.json` / `package-lock.json`** — npmscan (#143) sees
an empty lockfile diff and stays silent, which is a feature of this design.

## 4. Tests (hermetic, CI-safe — the `url-gate-browser.test.ts` pattern)

- A local `http.createServer` answering `/search` with a SearXNG-shaped JSON
  fixture; assert mapping, top-8 cap, error paths (404, malformed JSON,
  timeout, aborted signal). No external network, ever.
- Provider selection: default DDG (existing tests keep passing), `searxng`
  without `SEARXNG_URL` → error naming the var; typo → error.
- url-gate: with provider `searxng`, an off-whitelist `SEARXNG_URL` host is
  refused with the host named; on-whitelist passes.
- Extraction: fixture HTML — nav/footer/script stripped, `<article>`
  preferred, `<pre>` preserved, objective ranking picks the right paragraph,
  CJK text survives.
- Cancellation: abort mid-fetch → tool returns the abort error, server hit
  log proves no post-abort reads.

## 5. Commit decomposition (each green on its own)

1. `feat(extra-tools): thread pi's AbortSignal through webfetch/websearch` —
   standalone improvement, no behavior change otherwise.
2. `feat(extra-tools): provider-selected websearch with a self-hosted SearXNG backend`
   — search.ts + index.ts wiring + tests.
3. `feat(extra-tools): block-level extraction and objective-ranked excerpts in webfetch`
   — extract.ts + tests.
4. `fix(url-gate): gate the websearch endpoint the provider actually dials` —
   gate.ts + tests (land AFTER 2 so the pair is never inconsistent).
5. `docs: web provider env vars + SearXNG deployment + whitelist entry` +
   CHANGELOG.

## 6. SearXNG deployment (documented in README, ~10 lines)

```yaml
# docker-compose.yml (or podman run)
services:
  searxng:
    image: searxng/searxng
    ports: ["8888:8080"]
    volumes: ["./searxng-config:/etc/searxng"]
```
`settings.yml` must add `formats: [html, json]` under `search:` (json is off
by default). Then `LITTLE_CODER_WEB_PROVIDER=searxng
SEARXNG_URL=http://127.0.0.1:8888`, and add `127.0.0.1:8888` (or the LAN
host) to `~/.config/little-coder/url-whitelist.json`.

## 7. Alternatives considered and rejected

- **Brave/Kagi/Qwant/Mojeek APIs** — proprietary and/or key-bearing; fails
  the "open source only" rule.
- **Public SearXNG instances as default** — `format=json` usually disabled,
  aggressive rate-limiting, third-party destination by default; allowed only
  as a user-chosen whitelisted URL.
- **MCP client (`@modelcontextprotocol/sdk`) to talk to SearXNG's MCP server**
  — ~1200 lockfile lines for one JSON GET; violates minimal-deps; also
  re-introduces the exact dependency shape this fork declined in #139.
- **Scraping Bing/Google directly** — ToS-hostile, fragile, worse than the
  DDG scrape already in tree.
- **Full Mozilla Readability in webfetch** — needs a DOM (jsdom/linkedom =
  new dep) or per-call chromium; the Browser tools already cover that tier.
- **Local search index (SearXNG-with-crawl, Whoosh, MeiliSearch)** — searches
  a corpus you already have, not the web; out of scope.

## 8. Definition of done

- Default behavior byte-identical to today (DDG path untouched, existing
  tests green).
- `LITTLE_CODER_WEB_PROVIDER=searxng` + `SEARXNG_URL` returns excerpted
  results from a SearXNG-shaped fixture in tests and from a real local
  instance in a manual smoke run.
- `webfetch` output no longer contains nav/footer/script residue; `prompt`
  returns ranked excerpts.
- url-gate judges the real endpoint; an unwhitelisted instance fails closed.
- Cancellation stops in-flight requests (test-proven).
- `git diff` shows **no package.json/package-lock.json changes**;
  `npm run lint`, `npm run typecheck`, `npx vitest run` all green; npmscan
  check passes trivially.

## 9. Risks / open questions

- **Ops burden**: SearXNG needs a running container. Mitigated by DDG
  remaining the default and loud errors; but the feature is only as good as
  the user's willingness to run one container.
- **SearXNG JSON API stability**: stable for years, but pin behavior in tests
  against the documented response shape, not a live instance.
- **Extraction quality** will not match a hosted objective-aware service;
  the escape hatch is the Browser tools, not a smarter local ranker.
- Decide at implementation time whether `webfetch`'s extraction upgrade lands
  for the DDG default too (recommended: yes — it is provider-independent and
  strictly better than regex-strip).
