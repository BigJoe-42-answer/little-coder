# url-gate — outstanding work

Working notes for whoever picks this up next. Everything below is dated against
`feat/url-gate` at `3ee48f1`, little-coder v1.20.0, Node v26.11.1.

## Where it stands (verified, not assumed)

- **Branch:** `feat/url-gate` = `origin/main` + `d958e93` (feature) + `43b71e4`
  (no-UI wording fix) + `3ee48f1` (tracked policy file + setup script). Not pushed,
  no PR. The separate thinking-budget work lives on
  `fix/thinking-budget-env-and-user-settings` (`7472f14`) and does **not** contain
  url-gate.
- **Installed:** all four files byte-identical to the checkout in
  `/usr/lib/node_modules/little-coder`; `scripts/url-gate-setup.sh` re-installs and
  re-verifies (12/12 PASS log at `/tmp/url-gate-setup.log`).
- **Policy:** live = `~/.config/little-coder/url-whitelist.json` (17 hosts),
  tracked copy = `config/url-whitelist.json`, currently identical. Runtime reads
  only the live one.
- **Confirmed live:** host/path/wildcard matching; webfetch redirect-hop re-check;
  shell-command URL scanning (`curl` to an off-list host is refused while an
  on-list one runs); hot-reload after editing the file mid-session; sub-coders are
  gated and now report the real reason (no UI) instead of blaming an env var.
- **Tests:** 102 pass across `url-gate`/`extra-tools`/`permission-gate`; `tsc` clean.

## P1 — upstream durability

`npm i -g little-coder@latest` erases everything in `/usr/lib/node_modules/…`,
including this extension. Until it is merged upstream the fix survives only as
this branch plus `scripts/url-gate-setup.sh`.

```bash
git -C ~/Projects/little-coder push -u origin feat/url-gate
```

Suggested PR framing: `permission-gate` judges commands; some deployments want the
opposite split — commands free, network destinations controlled — and a gate that
only inspects tool inputs cannot deliver that, because under
`LITTLE_CODER_PERMISSION_MODE=accept-all` a `curl https://off-list.host` is just a
command. Reviewers will ask about the bypass list at the bottom of this file; the
README-level answer should be "tool-layer gate, network-layer fence if you need a
hard boundary."

## P1 — the browser half is unverified

Playwright's browser binary is not installed on this machine, which is also why
three tests in the suite fail (`Executable doesn't exist at
~/.cache/ms-playwright/…`). Needs `npx playwright install chromium` — a human has
to run `npx` (it is not on the shell allowlist).

Unverified paths: `BrowserNavigate`, `BrowserBack` re-navigating a history entry,
`BrowserHistory`. Also ungated **by design** today, and worth deciding rather than
discovering:

- a `BrowserClick` that navigates to an off-list host (the model never names a URL);
- JS/meta redirects and subresource loads inside an approved page;
- `BrowserExtract` of a page already loaded.

Candidate fix: a `page.on("request")` listener installed in `ensureSession()`
(`.pi/extensions/browser/index.ts`) that aborts requests whose host is off-list,
with the decision delegated to `url-gate/gate.ts` so hook, tool and browser agree.
Expect fallout: it also kills third-party trackers/images, which breaks some pages,
so it probably wants a mode (`off | main-frame | all`) rather than being always on.

## P2 — the hook has no automated tests

`gate.ts` (pure matching) has 28 tests. `index.ts` — the actual wiring: which tools
are inspected, shell scanning, the ask/block/no-UI branches, prompt flow, block
return shape — is proven only by live probes in a terminal. Add a hook-level test
with a fake `pi` + `ctx` in the style of
`permission-gate/manual-edit-confirm.test.ts`, asserting at minimum:

1. `webfetch` + off-list url → `{ block: true }`, prompt shown once;
2. approved host remembered for the session, second call not prompted;
3. `bash` with an off-list URL inside the command → blocked; same command with an
   on-list host → not blocked (the accept-all split);
4. `hasUI: false` → blocked with the no-UI sentence, **not** the block-mode one
   (the regression that shipped once);
5. `LITTLE_CODER_URL_GATE=off` → nothing blocked, no prompt.

## P2 — sub-coders fail closed, silently

A `dispatch` child has no UI, so every non-whitelisted host is refused with no
prompt possible (verified). That is safe but invisible: research sub-coders
quietly only ever see the whitelisted hosts. Options, in increasing effort:
document it in the extension header; pre-seed a research host list; or have the
child queue the approval question to the parent session's UI.

## P2 — no visibility into what is actually enforced

`sessionAllowedHostList()` in `gate.ts` is exported and never used — there is no
`/url-gate` command (`registerTool`/`registerCommand` count in `index.ts` is 0),
so a user cannot see the loaded patterns, whether the file parsed, the mode in
force, or which hosts they approved this session. Cheap win: `/url-gate` printing
file path + parse status + pattern count + mode + session-allowed hosts, plus
`/url-gate add <host>` appending to the live file.

## P3 — known bypasses (documented in source; fix some, never all)

| Bypass | Notes |
|---|---|
| `git@github.com:…`, `ssh://`, scheme-less URLs | `extractCommandUrls` only matches `http(s)://`; scp-style git remotes are invisible |
| `curl -L` own redirect hops | webfetch re-checks hops; a shell fetcher does not |
| package-manager traffic (`pip`, `npm`, `apt`) | no URL appears in the command text |
| a script that makes its own HTTP calls (`python3 crawl.py`) | cannot be seen at the tool layer |
| reader/proxy hosts | see do-not-add list below |

The honest framing: this is a *policy surface with a human in the loop*, not a
sandbox. A hard boundary needs `ufw`/`iptables` owner rules or a proxy allowlist.

## P3 — do-not-add list (put this in the shipped template so nobody re-learns it)

Proxy/reader/mirror hosts defeat the allowlist entirely because they fetch an
arbitrary URL for the model — verified for `r.jina.ai` ("convert any URL to an
LLM-friendly input"): `r.jina.ai`, `s.jina.ai`, `web.archive.org` / `*.archive.org`,
Google cache/transcode hosts, `allorigins.win`, `corsproxy.io`, `12ft.io`, any
"extract/read/proxy" SaaS. Attacker-writable content hosts are the other class:
`*.github.io`, `*.githubusercontent.com`, public CDNs (`unpkg`, `jsdelivr`,
`*.cloudfront.net`), pastebins, `transfer.sh`, `*.ngrok.io`, `*.s3.amazonaws.com`,
URL shorteners (already pointless — hops are re-checked).

## P3 — small code nits

- `whitelistPath()` trusts `XDG_CONFIG_HOME` blindly; a colon-delimited value
  (that is `XDG_CONFIG_DIRS`, which KDE sets here) produces a bogus path and a
  confusing "file not found". Validate, or fall through.
- `whitelistPath()` ignores `PI_CODING_AGENT_DIR`, which other little-coder config
  resolution honours.
- No IP-wildcard form: `192.168.40.*` is unsupported; exact IPs only. Fine for now,
  but say so in the schema note.
- Static import `extra-tools → ../url-gate/gate.ts` makes `extra-tools` hard-depend
  on `url-gate` being present; fine in the shipped set, worth a comment or a
  dynamic import if anyone ever prunes extensions.

## Unrelated failures already on this machine (not url-gate)

1. **3 tests need `npx playwright install chromium`** — missing browser binary.
2. **`llama-cpp-provider/swap-reprobe.test.ts` fails on a clean checkout too.** It
   stubs `fetch` to hand out `32768, 131072` in sequence and expects the *swap* to
   consume the second value, but it receives `32768` — i.e. something now makes one
   extra `/props` probe before the swap, shifting the stub's sequence. Smells like
   the v1.20.0 "one `/v1/models` fetch answers all three questions" change altering
   call counts. Worth a repro and an upstream issue; it may be masking a real
   swap-time re-probe bug rather than being a flaky test.

## Local config drift that will bite later

- `~/.config/little-coder/settings.json` still has
  `model_profiles."strata/iq3_s".thinking_budget = 32000`. The active model id is
  `strata/qwen3.8-flash-next-iq3_s`, a *different key*, so it does not apply today —
  pick `strata/iq3_s` once and that stale budget silently wins over the launcher's
  `LITTLE_CODER_THINKING_BUDGET=65536`. Re-key or delete it.
- `start_little-coder.sh` exports `LITTLE_CODER_PERMISSION_MODE=accept-all` (shell
  whitelist off, deliberate here; url-gate is unaffected — separate env).
- That launcher is a **non-interactive** bash, so nothing in `~/.bashrc` reaches it.
  Every env var little-coder needs must be exported there, not in `.bashrc`.
  (This is what made the whitelist silently resolve to "not found" the first time.)
