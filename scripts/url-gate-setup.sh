#!/usr/bin/env bash
# Install the url-gate extension into the GLOBAL little-coder package, then prove
# it is the code the checkout says it is, then check the policy file's two copies
# have not drifted apart.
#
#   bash ~/Projects/little-coder/scripts/url-gate-setup.sh
#
# sudo is needed for the package directory only (the policy file is user-owned).
# Everything printed also lands in /tmp/url-gate-setup.log (URL_GATE_LOG=/path to
# move it). Exit 0 = every check passed. Re-running is safe: it re-copies and
# re-verifies.

set -uo pipefail

REPO="${REPO:-$HOME/Projects/little-coder}"
INST="${INST:-/usr/lib/node_modules/little-coder}"
CFG_DIR="${CFG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/little-coder}"
LIVE="$CFG_DIR/url-whitelist.json"
TRACKED="$REPO/config/url-whitelist.json"
LOG="${URL_GATE_LOG:-/tmp/url-gate-setup.log}"
FAIL=0

: > "$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }

# Run a check quietly: command + output go to the log, a one-line verdict to the
# terminal. A failed check never stops the run, so you see the whole picture.
check() {
  local name="$1"; shift
  { printf '\n$ %s\n' "$*"; "$@"; } >>"$LOG" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    say "  PASS  $name"
  else
    say "  FAIL  $name  (exit=$rc — the command and its output are in $LOG)"
    FAIL=$((FAIL + 1))
  fi
}

say "url-gate setup — $(date -Is)"
say "  repo:    $REPO  branch=$(git -C "$REPO" branch --show-current 2>/dev/null || echo '?')  HEAD=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')"
say "  install: $INST  v$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$INST/package.json" 2>/dev/null || echo '?')"
say "  node:    $(node -v)"
say "  log:     $LOG"

if [ ! -d "$INST/.pi/extensions" ]; then
  say "  FAIL  no little-coder package at $INST — set INST=/path and re-run"
  exit 1
fi
if [ ! -d "$REPO/.pi/extensions/url-gate" ]; then
  say "  FAIL  no url-gate in $REPO — set REPO=/path and re-run"
  exit 1
fi

say
say "sudo is needed only for $INST"
sudo -v || { say "  FAIL  sudo declined"; exit 1; }

say
say "== copying extension code into the package"
mkdir -p "$INST/.pi/extensions/url-gate"
for f in gate.ts index.ts gate.test.ts; do
  if sudo cp "$REPO/.pi/extensions/url-gate/$f" "$INST/.pi/extensions/url-gate/$f"; then
    say "  copied url-gate/$f"
  else
    say "  FAIL  could not copy url-gate/$f"; FAIL=$((FAIL + 1))
  fi
done
if sudo cp "$REPO/.pi/extensions/extra-tools/index.ts" "$INST/.pi/extensions/extra-tools/index.ts"; then
  say "  copied extra-tools/index.ts"
else
  say "  FAIL  could not copy extra-tools/index.ts"; FAIL=$((FAIL + 1))
fi

say
say "== installed code matches the checkout, file by file"
for pair in .pi/extensions/url-gate/gate.ts .pi/extensions/url-gate/index.ts .pi/extensions/url-gate/gate.test.ts .pi/extensions/extra-tools/index.ts; do
  check "identical: $pair" diff -q "$REPO/$pair" "$INST/$pair"
done

say
say "== the four behaviours this install is meant to deliver"
check "hot reload compares a REMEMBERED mtime (was comparing one file against itself)" \
  grep -q 'mtimeMs === current.mtimeMs' "$INST/.pi/extensions/url-gate/gate.ts"
check "a no-UI refusal names the real cause instead of blaming LITTLE_CODER_URL_GATE" \
  grep -q 'no interface to ask the user' "$INST/.pi/extensions/url-gate/gate.ts"
check "URLs inside shell commands are scanned, not just tool inputs" \
  grep -q 'extractCommandUrls' "$INST/.pi/extensions/url-gate/index.ts"
check "webfetch re-checks every redirect hop" \
  grep -q 'checkRedirectHop' "$INST/.pi/extensions/extra-tools/index.ts"

say
say "== policy file (runtime reads the live one; git tracks the copy)"
if [ ! -f "$LIVE" ]; then
  if mkdir -p "$CFG_DIR" && cp "$TRACKED" "$LIVE"; then
    say "  no live config — created $LIVE from the tracked copy"
  else
    say "  FAIL  could not create $LIVE"; FAIL=$((FAIL + 1))
  fi
fi
check "live config parses and has at least one entry" \
  node -e 'const d=require(process.argv[1]); process.exit(Array.isArray(d.allowed)&&d.allowed.length>0?0:1)' "$LIVE"
check "live config and tracked copy agree (a FAIL here means drift, not breakage)" \
  diff -q "$LIVE" "$TRACKED"
say "  live:     $LIVE"
say "  tracked:  $TRACKED"
say "  hosts:    $(node -e 'process.stdout.write(require(process.argv[1]).allowed.join(" "))' "$LIVE" 2>/dev/null || echo '?')"

say
say "== repo checks (tests + typecheck)"
cd "$REPO" || exit 1
check "url-gate, extra-tools, permission-gate tests" \
  node ./node_modules/vitest/vitest.mjs run .pi/extensions/url-gate .pi/extensions/extra-tools .pi/extensions/permission-gate
check "typecheck (tsc --noEmit)" node node_modules/typescript/bin/tsc --noEmit

say
say "== summary"
if [ "$FAIL" -eq 0 ]; then
  say "  ALL CHECKS PASSED. Restart little-coder to load the new extension code."
else
  say "  $FAIL check(s) FAILED. Details: $LOG"
fi
say
say "Then verify at runtime, from inside a little-coder session:"
say "  1. fetch https://docs.python.org/3/library/json.html  -> content, no prompt, no warning line"
say "  2. run  curl -sSI https://example.com                 -> refused (deny the prompt)"
say "  3. add  \"example.com\" to $LIVE"
say "     then run that curl again                            -> runs, no restart (proves hot reload)"
say "  4. dispatch a sub-coder to fetch example.com          -> refused, and the message says there"
say "     is no interface to ask in — NOT that LITTLE_CODER_URL_GATE=block is set (proves fix 1)"
[ "$FAIL" -eq 0 ] || exit 1
