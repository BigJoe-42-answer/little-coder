# PLAN.md — Fork quality & safety review → one comprehensive PR

**Purpose.** Give a future session a verified map of this fork's current state and a
concrete plan for a **single comprehensive PR** ("fork quality pass") that consolidates
all uncommitted work, fixes the known defects, and hardens the update/launch paths.

**Ground rules for the PR.** This is a private fork of `itayinbarr/little-coder`
(v1.20.0 base) — upstream contribution rules in `AGENTS.md` do not bind it, but the
same standards should: every line understood, tested, and defensible. One PR, small
reviewable commits, each green on its own.

---

## 1. Current state (verified 2026-11-26)

### Repo & git
- Path: `/home/fred/Projects/little-coder`, base upstream `v1.20.0` (`cb10cfc`).
- Branches:
  - `main` — upstream history.
  - `feat/url-gate` (**checked out**, HEAD `f6b7973`) — url-gate feature; see
    `docs/url-gate-todo.md` for its own outstanding-work notes (unpushed).
  - `fix/thinking-budget-env-and-user-settings` (`7472f14`) — thinking-budget
    env-precedence fix (#130/#131/#137) + benchmark-profiles user-settings merge.
- **All fork runtime changes are UNCOMMITTED on `feat/url-gate`** (14 modified files +
  untracked `launch/`, `start-little-coder.sh`). `git status` is the inventory.
- Verified: the uncommitted `thinking-budget/index.ts` and
  `benchmark-profiles/index.ts` are **byte-identical to branch
  `fix/thinking-budget-env-and-user-settings`** — the working tree re-created commit
  `7472f14` by copying from the patched global install. Reconcile via git, not copies.

### Runtime layout (three copies of little-coder exist — the biggest confusion source)
1. **This repo** — the fork's source of truth. pi pinned `^1.6.1` in package.json;
   lockfile regenerated 2026-11-26 (also pulled playwright 1.59 → 1.65.1).
2. **Global install** `/usr/lib/node_modules/little-coder` (root-owned, `little-coder`
   on PATH via `/usr/bin/little-coder`) — **stale**: old little-coder-targeted update
   check, plus hand-applied extension patches with `.bak` files
   (`index.ts.pre-thinking-budget-fix.*.bak`). Bundles pi 1.5.2.
3. **Transport launchers** `/home/fred/little-coder-transport/start_little-coder.sh`
   (the alt Desktop entry reuses it with `--system-prompt alt-system-prompt.md`)
   — env setup (strata key, thinking budget 12000,
   subcoder concurrency 1, model auto-sync, llama fallback). Resolves little-coder via
   `command -v`; hardcodes `PI_PKG_JSON=/usr/lib/node_modules/...` for its
   builtin:mcp check.

### Launch path in use (since 2026-11-26)
- `Projects/little-coder/start-little-coder.sh` (untracked) prepends
  `Projects/little-coder/launch/` (shim `little-coder` → `bin/little-coder.mjs`) to
  PATH, then execs the transport script → **the repo copy runs**, transport env kept.
- Desktop entries `~/Desktop/Link to Application.desktop` and
  `~/Desktop/little-coder-alt.desktop` point at the new script.

### Test status
- `npx vitest run`: **896 passed, 1 failed, 14 skipped**. The failure is
  `llama-cpp-provider/swap-reprobe.test.ts` ("re-registers llamacpp with the new
  window"): expects ctx 131072, gets 32768. **Pre-existing** — fails on clean HEAD
  too (verified via `git stash`).
- `npm run typecheck`: **FAILS — 3 TS errors** against pi 1.6.1 types:
  `skill-inject/index.ts` ×2, `knowledge-inject/index.ts` ×1
  (`Property 'prompt' does not exist on type 'BeforeAgentStartEvent'`).
- CI (`.github/workflows/ci.yml`) runs **only `npm ci --ignore-scripts`** — no tests,
  no typecheck. That is how both the failing test and the typecheck drift went unnoticed.

---

## 2. Fork changes vs upstream (what the PR must consolidate)

All currently uncommitted; each was tested when made:

1. **Update flow retargeted to pi** (`bin/update-check.mjs`, `bin/little-coder.mjs`,
   `.pi/extensions/update-notice/`): never check/update the `little-coder` package
   (would clobber the fork); poll `@earendil-works/pi-coding-agent`, install in place
   with `npm install --ignore-scripts --no-package-lock --prefix <pkgRoot>`.
2. **Update logging**: full npm transcript appended to
   `~/.cache/little-coder/update.log` from both the launcher prompt path and `/update`;
   failure path echoes npm's last 12 lines inline + names the log.
3. **pi runtime patcher modernized** (`scripts/patch-pi.mjs` + tests): anchors
   refreshed for pi 1.5/1.6; new **bundle-chunk targets** (pi's bin is
   `dist/bundle/cli.js`, so pre-1.5 anchors patched dead code — markers verified
   absent in the old global pi 1.5.2, i.e. patches were silently no-ops in production);
   glob support for hashed chunk names; tests made glob-aware.
4. **Fork patches ported into repo** (identical to `7472f14`): thinking-budget env
   precedence, benchmark-profiles settings merge.
5. **Branding**: tagline → "A fork of little-coder, tuned for small local models".
6. **pi dependency** `^0.83.0` → `^1.6.1` (npm rewrote the exact pin to caret during
   the update); lockfile regenerated from scratch.
7. **README** troubleshooting updated for the pi-targeted flow + log path.
8. **Launcher shim** (`launch/little-coder`, `start-little-coder.sh`) — untracked.

---

## 3. Findings to address in the PR

Ordered roughly by risk. Each item: evidence → action.

### F1. Uncommitted work + branch duplication (hygiene, high)
- 14 modified files + 2 untracked live only in the working tree; the same
  extension patches also exist as commit `7472f14` on another branch.
- **Action:** merge `fix/thinking-budget-env-and-user-settings` into the PR branch
  (or cherry-pick `7472f14`), drop the duplicated working-tree copies of those two
  `index.ts` files, then commit the remaining fork changes as discrete commits (§4).
  Decide explicitly: commit `launch/` + `start-little-coder.sh` into the repo
  (recommended — they are the documented launch path) or gitignore them and document
  elsewhere.

### F2. CI runs no tests and no typecheck (high)
- Evidence: `ci.yml` only `npm ci --ignore-scripts`. A failing test and 3 TS errors
  sit on the checked-out branch.
- **Action:** add `npm run typecheck` and `npx vitest run` to CI. Live tests
  (url-gate chromium, Wikipedia integration) need browsers: either
  `npx playwright install chromium` in CI or tag/mark live tests (e.g.
  `vitest --exclude '**/*live*'` convention) — pick one and document it.

### F3. swap-reprobe test failure (medium — pre-existing, must resolve)
- `registers.at(-1)?.ctx` is 32768, expected 131072. Fails on clean HEAD, so it is
  either a real regression in `llama-cpp-provider` swap re-probe (#54 behavior) or a
  stale test expectation.
- **Action:** bisect when it started failing; fix the extension or the test. Do NOT
  skip it.

### F4. typecheck drift vs pi 1.6.1 (medium)
- `BeforeAgentStartEvent.prompt` removed/renamed upstream between pi 0.83 and 1.6.1;
  skill-inject/knowledge-inject still reference it. Runtime may be fine (jiti strips
  types) but the contract is unverified.
- **Action:** fix the three call sites against pi 1.6.1's event types; add a narrow
  type test if the event shape matters at runtime.

### F5. pi version ↔ patcher anchors coupling (high, safety-adjacent)
- `patch-pi.mjs` matches exact source text in pi's dist AND in hashed bundle chunks
  (`chunk-*.js`). A pi bump can silently no-op the abort-marker and edit-repair
  patches (this already happened once: global pi 1.5.2 had **zero** patch markers).
  The refreshed tests now fail loudly — keep that property.
- package.json says `^1.6.1` (caret) — a future `npm install` can pull 1.7.x without
  anchor review. **Decide:** pin exact (`1.6.1`) with a documented bump procedure
  (bump → run patch-pi tests → refresh anchors → regenerate lock), or keep caret and
  make CI's patch-pi test the gate. Recommend exact pin for a fork.
- The update flow uses `--no-package-lock` (works around an npm arborist crash —
  `Link.matches` null-name — triggered by the `overrides: node-domexception →
  file:./vendor/node-domexception` link when re-resolving an existing lock). Side
  effect: **the lockfile goes stale after every auto-update** (package.json moves,
  lock doesn't). **Action:** document the manual lock refresh
  (`rm package-lock.json && npm install --ignore-scripts && npx playwright install
  chromium`) in the bump procedure, and note the npm bug + minimal repro in a comment
  (already in `update-check.mjs`) or pin npm via `engines`.

### F6. Three runtime copies drift (high — this caused two bug reports already)
- Stale global install still on PATH; its update check targets little-coder and finds
  nothing; it also carries hand-applied patches with `.bak` litter.
- Transport script hardcodes `PI_PKG_JSON=/usr/lib/node_modules/...` for the
  builtin:mcp check — reads the stale copy even when the repo copy runs.
- **Action (decision needed with the user):** uninstall the global copy
  (`sudo npm uninstall -g little-coder`) or clearly mark it deprecated; fix the
  transport script to derive `PI_PKG_JSON` from `command -v little-coder`'s resolved
  package root. Record the chosen launch topology in README (Desktop →
  start-little-coder.sh → transport → repo shim).

### F7. Update-path safety review (medium)
- Good: `--ignore-scripts` everywhere (issue #50 posture), semver gate before the
  version string reaches any shell sink, Windows COMSPEC path, re-exec loop guard.
- To improve:
  - `update.log` grows unbounded and is world-readable by default → `chmod 600` on
    create, and trim to the last N transcripts (or rotate).
  - The version-check cache (`version-check.json`) is trusted for 12 h; fine, but the
    update installs whatever the cache says without re-fetching when `force` is off —
    acceptable; state it in a comment.
  - No `npm audit`/integrity step after install — npm itself verifies integrity; note
    that explicitly rather than adding machinery.
  - Windows branches (`win32` spawn paths) are untested — mark as best-effort.

### F8. Security posture of the launch environment (medium, mostly out of code scope)
- Transport launcher sets `LITTLE_CODER_PERMISSION_MODE=accept-all`; the compensating
  control is url-gate, whose known bypasses are listed in `docs/url-gate-todo.md`
  (scripts making their own HTTP calls, `curl -L` hops). Keep those limitations
  visible; do not let the PR imply the gate is a network sandbox.
- Transport writes diagnostics to fixed `/tmp/little-coder-diag.log` (predictable
  path, shared /tmp) — recommend `$XDG_STATE_HOME` or `mktemp -d`; it already chmods
  600 after create, which is a symlink-race window, not a fix.
- API key handling (file-based, never in scripts) is sound; keep it that way.
- `vendor/node-domexception` override: verify NOTICE/LICENSE and why the vendor copy
  exists before the PR touches dependencies at all.

### F9. Code-quality nits (low)
- `bin/update-check.test.mjs` uses `require("node:fs")` inside ESM (vitest tolerates;
  use a static import).
- Log-path helper is duplicated in `update-check.mjs` and `update-notice/index.ts`
  (extension can't import bin/ cleanly) — acceptable; cross-reference in comments
  (partly done) or move to a shared `_shared/` module.
- branding: no test pins the tagline; add one if the tagline is contractual.
- `docs/architecture.md` predates the fork's update retarget; check for stale prose.
- CHANGELOG `[Unreleased]` has no fork entries — add them (Keep-a-Changelog format,
  match the existing voice).

---

## 4. Proposed PR shape (single PR, one commit per concern)

Branch: `chore/fork-quality-pass` off `feat/url-gate` (or fold into it — decide with
the user; url-gate is itself unpushed).

1. `fix(thinking-budget)+fix(benchmark-profiles): merge fork patches` — merge
   `7472f14`; reconcile working tree.
2. `feat(update): target pi, install in place, log npm transcript` — update-check,
   little-coder.mjs, update-notice + their tests.
3. `fix(patch-pi): refresh anchors for pi 1.5/1.6, patch the bundle the bin runs` +
   glob-aware tests.
4. `build(deps): pin pi 1.6.1, regenerate lockfile` (+ playwright note).
5. `fix(tests): swap-reprobe` and `fix(types): skill/knowledge-inject vs pi 1.6.1`.
6. `ci: run typecheck + vitest` (+ live-test policy).
7. `docs: README/CHANGELOG/architecture for the fork flow` + launch topology.
8. `chore: launcher shim + desktop topology` (if committed to repo).

Each commit must keep `npx vitest run` and `npm run typecheck` green (fix F3/F4
before landing CI in commit 6, or land CI as draft-gate last).

## 5. Definition of done

- `git status` clean; all fork work on branches; no duplicated patch copies.
- `npx vitest run`: **0 failures** (swap-reprobe fixed or explained in a commit msg).
- `npm run typecheck`: clean.
- CI runs install + typecheck + tests on push/PR.
- Update flow e2e passes (recipe §6.4); `update.log` created with mode 600 and
  bounded size.
- Patch markers verified present in the installed pi bundle (§6.5).
- One launch topology documented; stale global copy resolved (removed or marked).
- CHANGELOG `[Unreleased]` covers every user-visible fork change.

## 6. Verification recipes

```bash
# 6.1 full suite (expect 0 failures once F3 fixed)
cd /home/fred/Projects/little-coder && npx vitest run

# 6.2 types
npm run typecheck

# 6.3 launcher topology smoke (should print the repo shim, not /usr/bin)
PATH=/home/fred/Projects/little-coder/launch:$PATH bash -c 'command -v little-coder'

# 6.4 update flow end-to-end (simulated 'y' via pty; installs pi@latest in place)
printf 'y\n' | script -qec "cd /home/fred/Projects/little-coder && node -e \
  \"import('./bin/update-check.mjs').then(m=>m.checkForUpdate('0.0.0',{skip:false,force:true,pkgRoot:process.cwd()}))\"" /dev/null
tail -20 ~/.cache/little-coder/update.log

# 6.5 patch markers present in the pi the launcher actually spawns
grep -c "little-coder patch" \
  node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-*.js \
  node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js

# 6.6 lockfile/package.json agreement (guards F5 lock drift)
node -e "const l=require('./package-lock.json'),p=require('./package.json');
console.log(l.packages['node_modules/@earendil-works/pi-coding-agent'].version,
            p.dependencies['@earendil-works/pi-coding-agent'])"
```

## 7. Explicitly out of scope (follow-ups, not this PR)

- Upstreaming any fork fix to `itayinbarr/little-coder` (requires a human owner per
  upstream AGENTS.md; the thinking-budget and patch-pi refresh are good candidates
  eventually).
- url-gate network-layer gaps (`docs/url-gate-todo.md`).
- Playwright/browser pinning beyond the dependency bump.
- Benchmark re-runs; the fork's behavior changes (thinking precedence) may shift
  benchmark profiles.
