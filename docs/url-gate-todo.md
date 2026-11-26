# url-gate — known gaps and open work

The durable gap list for `url-gate`: what it does NOT enforce, and the open
work items. Verified behavior and design rationale live in the source comments
([`.pi/extensions/url-gate/`](../.pi/extensions/url-gate),
[`.pi/extensions/browser/request-gate.ts`](../.pi/extensions/browser/request-gate.ts))
and the CHANGELOG — this file is only the gaps, so nobody re-learns them.

## P2 — the hook has no automated tests

`gate.ts` (pure matching) has 34 tests. `index.ts` — the actual wiring: which
tools are inspected, shell scanning, the ask/block/no-UI branches, prompt flow,
block return shape — is proven only by live probes in a terminal. Add a
hook-level test with a fake `pi` + `ctx` in the style of
`permission-gate/manual-edit-confirm.test.ts`, asserting at minimum:

1. `webfetch` + off-list url → `{ block: true }`, prompt shown once;
2. approved host remembered for the session, second call not prompted;
3. `bash` with an off-list URL inside the command → blocked; same command with
   an on-list host → not blocked (the accept-all split);
4. `hasUI: false` → blocked with the no-UI sentence, **not** the block-mode one
   (the regression that shipped once);
5. `LITTLE_CODER_URL_GATE=off` → nothing blocked, no prompt.

## P2 — sub-coders fail closed, silently

A `dispatch` child has no UI, so every non-whitelisted host is refused with no
prompt possible (verified). That is safe but invisible: research sub-coders
quietly only ever see the whitelisted hosts. Options, in increasing effort:
document it in the extension header; pre-seed a research host list; or have
the child queue the approval question to the parent session's UI.

## P2 — no visibility into what is actually enforced

`sessionAllowedHostList()` in `gate.ts` is exported and never used — there is
no `/url-gate` command (`registerTool`/`registerCommand` count in `index.ts`
is 0), so a user cannot see the loaded patterns, whether the file parsed, the
mode in force, or which hosts they approved this session. Cheap win:
`/url-gate` printing file path + parse status + pattern count + mode +
session-allowed hosts, plus `/url-gate add <host>` appending to the live file.

## P3 — known bypasses (documented in source; fix some, never all)

| Bypass | Notes |
|---|---|
| `git@github.com:…`, `ssh://`, scheme-less URLs | `extractCommandUrls` only matches `http(s)://`; scp-style git remotes are invisible |
| `curl -L` own redirect hops | webfetch re-checks hops; a shell fetcher does not |
| package-manager traffic (`pip`, `npm`, `apt`) | no URL appears in the command text |
| a script that makes its own HTTP calls (`python3 crawl.py`) | cannot be seen at the tool layer |
| reader/proxy hosts | see do-not-add list below |

The honest framing: this is a *policy surface with a human in the loop*, not a
sandbox. A hard boundary needs `ufw`/`iptables` owner rules or a proxy
allowlist.

## P3 — do-not-add list (mirrored in the shipped template so nobody re-learns it)

Proxy/reader/mirror hosts defeat the allowlist entirely because they fetch an
arbitrary URL for the model — verified for `r.jina.ai` ("convert any URL to an
LLM-friendly input"): `r.jina.ai`, `s.jina.ai`, `web.archive.org` /
`*.archive.org`, Google cache/transcode hosts, `allorigins.win`, `corsproxy.io`,
`12ft.io`, any "extract/read/proxy" SaaS. Attacker-writable content hosts are
the other class: `*.github.io`, `*.githubusercontent.com`, public CDNs
(`unpkg`, `jsdelivr`, `*.cloudfront.net`), pastebins, `transfer.sh`,
`*.ngrok.io`, `*.s3.amazonaws.com`, URL shorteners (already pointless — hops
are re-checked).

## P3 — small code nits

- `whitelistPath()` trusts `XDG_CONFIG_HOME` blindly; a colon-delimited value
  (that is `XDG_CONFIG_DIRS`, which KDE sets) produces a bogus path and a
  confusing "file not found". Validate, or fall through.
- `whitelistPath()` ignores `PI_CODING_AGENT_DIR`, which other little-coder
  config resolution honours.
- Static import `extra-tools → ../url-gate/gate.ts` makes `extra-tools`
  hard-depend on `url-gate` being present; fine in the shipped set, worth a
  comment or a dynamic import if anyone ever prunes extensions.
