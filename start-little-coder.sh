#!/bin/bash
# little-coder fork launcher — the project-directory counterpart of
# /home/fred/little-coder-transport/alt-system-prompt.sh.
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
exec /home/fred/little-coder-transport/start_little-coder.sh "$@"
