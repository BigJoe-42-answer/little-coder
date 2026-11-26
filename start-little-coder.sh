#!/bin/bash
# little-coder fork launcher — the shared entry point behind the Desktop
# entries: base, alt (same launcher + --system-prompt alt-system-prompt.md),
# and research (same launcher + LITTLE_CODER_WEB_PROVIDER=searxng through env).
#
# Why: the global install at /usr/lib/node_modules/little-coder is stale
# (its update check still targets the little-coder package, so it never
# notices a newer pi). This checkout carries the fork's fixes: the
# pi-targeted update check, the in-TUI /update flow, and the "fork of
# little-coder" branding.
#
# How: the transport launcher resolves little-coder via `command -v`, so
# putting this repo's launch/ shim first on PATH makes it spawn THIS
# checkout. All of the transport script's environment setup (provider key,
# thinking budget, model auto-sync, strata URL discovery, diagnostics,
# llama fallback) is reused unchanged. Extra args pass through, e.g.
#   start-little-coder.sh --system-prompt /path/to/alt-system-prompt.md
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HERE/launch:$PATH"

# ── web search provider (opt-in; the default keeps behavior unchanged) ─────
# Set HERE (or export before launch) so BOTH the container lifecycle below
# and the session see them: they inherit down transport -> pi -> sub-coders.
# To use the self-hosted SearXNG backend, flip the default below to searxng
# and make sure the quadlet unit is installed (see README "This fork"):
#   install -m 644 "$HERE/launch/lc-searxng.container" \
#     ~/.config/containers/systemd/lc-searxng.container && systemctl --user daemon-reload
# and add 127.0.0.1:8888 to ~/.config/little-coder/url-whitelist.json.
export LITTLE_CODER_WEB_PROVIDER="${LITTLE_CODER_WEB_PROVIDER:-duckduckgo}"
export SEARXNG_URL="${SEARXNG_URL:-http://127.0.0.1:8888}"

# ── session-scoped SearXNG container (docs/web-search-open-plan.md §2.6) ───
# This launcher owns the container: start on launch, stop when the LAST
# little-coder session exits. The quadlet unit (launch/lc-searxng.container)
# has NO [Install] section and Restart=no on purpose — a boot-enabled or
# auto-restarting unit would fight the session that deliberately stopped it.
# With provider duckduckgo this whole section is inert: podman/systemd are
# never touched.
LC_SEARXNG_UNIT="lc-searxng.service"
LC_SEARXNG_OWNED=no
LC_CHILD_PID=0

lc_searxng_start() {
  [ "$LITTLE_CODER_WEB_PROVIDER" = "searxng" ] || return 0
  # systemctl --user start is idempotent: a container left running by a
  # crashed previous session is simply reused (the leak is self-healing).
  if ! systemctl --user start "$LC_SEARXNG_UNIT" 2>/dev/null; then
    echo "WARNING: $LC_SEARXNG_UNIT could not be started — is launch/lc-searxng.container installed under ~/.config/containers/systemd/? websearch (provider=searxng) will report the failure." >&2
    return 0
  fi
  LC_SEARXNG_OWNED=yes
  # Readiness: SearXNG boots in ~2-5 s; poll the instance up to ~15 s. If it
  # never answers, warn and CONTINUE — websearch then fails loudly naming the
  # URL (plan §2.1) rather than the launcher blocking a session start forever.
  local i
  for i in $(seq 1 15); do
    curl -fsS -m 2 -o /dev/null "$SEARXNG_URL/" 2>/dev/null && return 0
    sleep 1
  done
  echo "WARNING: SearXNG at $SEARXNG_URL did not answer within 15s — check: systemctl --user status $LC_SEARXNG_UNIT. websearch will report the failure." >&2
}

lc_searxng_stop() {
  [ "$LC_SEARXNG_OWNED" = yes ] || return 0
  # Multi-session guard: two Desktop windows share one container, and the
  # first one closing must not cut the second off. The pattern is the REAL
  # session process: the launch/ shim execs `node <repo>/launch/../bin/
  # little-coder.mjs`, so that path is in every session's cmdline. OUR child
  # is excluded — on a signal-driven exit it may still be alive while this
  # trap runs, and counting it as "another session" would leak the container.
  if pgrep -f "bin/little-coder\.mjs" 2>/dev/null | grep -vx -- "$LC_CHILD_PID" | grep -q .; then
    echo "little-coder: another session is still running — leaving $LC_SEARXNG_UNIT up." >&2
    return 0
  fi
  systemctl --user stop "$LC_SEARXNG_UNIT" 2>/dev/null || true
}

lc_exit() {
  local rc=$?
  lc_searxng_stop
  exit "$rc"
}
trap lc_exit EXIT

# The transport script is machine-specific (env setup, provider key, model
# auto-sync, llama fallback). Resolve it through LC_TRANSPORT so this repo is
# honest on other machines: default is THIS machine's path, and a missing file
# fails loudly naming the variable instead of dying with a bare bash error.
LC_TRANSPORT="${LC_TRANSPORT:-/home/fred/little-coder-transport/start_little-coder.sh}"
if [ ! -f "$LC_TRANSPORT" ]; then
  echo "ERROR: transport script not found: $LC_TRANSPORT" >&2
  echo "start-little-coder.sh wraps the machine's transport script (env setup, model sync)." >&2
  echo "Point it at yours:  LC_TRANSPORT=/path/to/start_little_coder.sh $0" >&2
  exit 1
fi

lc_searxng_start

# The transport script runs as a CHILD, not via exec: exec would replace this
# shell and kill the EXIT trap. The EXIT trap fires on normal exit, Ctrl-C and
# window close alike (verified on this machine: the child's code propagates,
# SIGINT and SIGHUP both run the trap).
# The <&0 is load-bearing, not decoration: a non-interactive bash redirects a
# background job's stdin from /dev/null, so without it the TUI (and the
# transport's final read -p) sees immediate EOF and the window closes the
# moment it opens. <&0 re-attaches this script's stdin (the terminal) to the
# child — removing it reproduces the bug (verified: the child reads EOF).
"$LC_TRANSPORT" "$@" <&0 &
LC_CHILD_PID=$!
wait "$LC_CHILD_PID"
exit $?
