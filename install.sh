#!/usr/bin/env bash
# install.sh — installer for THIS fork of little-coder, from a source checkout.
#
# This fork is NOT published to npm. Never `npm install -g little-coder` over
# it — that installs the upstream package and clobbers the fork (README,
# "This fork"). Install from the clone instead:
#
#   git clone <your-fork-url> little-coder && cd little-coder
#   ./install.sh              # runtime deps only (any machine)
#   ./install.sh --desktop    # + KDE Desktop integration for the current user
#
# --desktop installs, for the CURRENT user only (no sudo), everything the
# README "This fork" section recipes by hand: the SearXNG quadlet unit, a
# generated SearXNG settings.yml (mode 600, never overwritten), the three
# brand icons, the Desktop entries (with the repo path substituted for this
# checkout), and the 127.0.0.1:8888 url-whitelist entry. Every step is
# idempotent; existing files are never clobbered.
set -euo pipefail

say() { printf '\033[1;36m[little-coder]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[little-coder]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[little-coder]\033[0m %s\n' "$*" >&2; }

# 1. node + npm present?
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node 22.19+ from https://nodejs.org or via nvm: 'nvm install 22'."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found. It usually ships with Node.js — reinstall Node from https://nodejs.org."
  exit 1
fi

# 2. node >= 22.19.0 (matches @earendil-works/pi-coding-agent's minimum)
NODE_V=$(node -p "process.versions.node")
if ! node -e '
  const [a,b] = process.versions.node.split(".").map(Number);
  if (a < 22 || (a === 22 && b < 19)) process.exit(1);
'; then
  err "Node $NODE_V is too old. little-coder needs >= 22.19.0."
  err "Try: nvm install 22 && nvm use 22"
  exit 1
fi
say "Node $NODE_V detected."

# 3. must run from the fork checkout (there is no npm package to fetch)
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$REPO/package.json" ] || [ ! -f "$REPO/launch/little-coder" ] || \
   [ ! -f "$REPO/start-little-coder.sh" ]; then
  err "install.sh must be run from the little-coder fork checkout (clone the repo first)."
  exit 1
fi

DESKTOP=no
if [ "${1:-}" = "--desktop" ]; then DESKTOP=yes; fi

# 4. dependencies. --ignore-scripts is the documented posture (issue #50/#75:
# no npm install scripts, ever — pi is patched at launch time instead, by
# scripts/patch-pi.mjs, which self-heals on every start).
npm install --ignore-scripts
say "npm dependencies installed (pi patched at first launch by scripts/patch-pi.mjs)."

# 5. browser tool runtime (the Browser* tools; core works without it)
if npx playwright install chromium; then
  say "playwright chromium installed."
else
  warn "playwright chromium install failed — the Browser* tools will not work until 'npx playwright install chromium' succeeds."
fi

# 6. smoke: the launch/ shim must shadow any global little-coder install
SHIM="$(PATH="$REPO/launch:$PATH" command -v little-coder)"
if [ "$SHIM" != "$REPO/launch/little-coder" ]; then
  err "launch/ shim did not resolve — got $SHIM"
  exit 1
fi
say "launch/ shim resolves: $SHIM"

# 7. optional Desktop integration (idempotent, current user only)
if [ "$DESKTOP" = yes ]; then
  # 7a. SearXNG quadlet unit — no [Install] section, Restart=no: session-scoped,
  # start-little-coder.sh owns its lifecycle. Never boot-enabled.
  install -D -m 644 "$REPO/launch/lc-searxng.container" \
    ~/.config/containers/systemd/lc-searxng.container
  systemctl --user daemon-reload
  say "quadlet unit installed (~/.config/containers/systemd/lc-searxng.container)."

  # 7b. SearXNG settings — generated once, mode 600, NEVER overwritten (the
  # secret_key must stay stable across restarts).
  SX=~/.config/little-coder/searxng/settings.yml
  if [ ! -f "$SX" ]; then
    mkdir -p "$(dirname "$SX")"
    umask 077
    cat > "$SX" <<EOF
use_default_settings: true
server:
  secret_key: "$(openssl rand -hex 32)"
  limiter: false              # loopback single-user instance
search:
  formats: [html, json]       # the json format is what websearch dials
EOF
    say "SearXNG settings generated at $SX (mode 600)."
  else
    say "SearXNG settings already present, left untouched: $SX"
  fi

  # 7c. brand icons into the user icon theme
  for i in little-coder little-coder-alt little-coder-research; do
    install -D -m 644 "$REPO/launch/icons/$i.svg" \
      ~/.local/share/icons/hicolor/scalable/apps/$i.svg
  done
  say "Desktop icons installed."

  # 7d. Desktop entries — the repo copies carry absolute paths for the canonical
  # machine; substitute the actual checkout root so they work wherever the fork
  # is cloned.
  mkdir -p ~/Desktop
  for d in little-coder little-coder-research; do
    sed "s|/home/fred/Projects/little-coder|$REPO|g" \
      "$REPO/launch/$d.desktop" > ~/Desktop/$d.desktop
    chmod 755 ~/Desktop/$d.desktop
    gio set ~/Desktop/$d.desktop metadata::trusted true 2>/dev/null || \
      warn "could not mark ~/Desktop/$d.desktop trusted — right-click it and 'Allow Launching' once."
  done
  say "Desktop entries installed (little-coder, little-coder-research)."

  # 7e. url-whitelist: seed from the repo template if absent, then make sure
  # the loopback SearXNG endpoint is listed (JSON-safe merge via node).
  WL=~/.config/little-coder/url-whitelist.json
  if [ ! -f "$WL" ]; then
    install -D -m 644 "$REPO/config/url-whitelist.json" "$WL"
    say "url-whitelist seeded from config/url-whitelist.json."
  fi
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.allowed = j.allowed || [];
    if (!j.allowed.includes("127.0.0.1:8888")) {
      j.allowed.push("127.0.0.1:8888");
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
      console.log("added 127.0.0.1:8888");
    } else console.log("127.0.0.1:8888 already listed");
  ' "$WL"
fi

say "Done."
say "Run:    $REPO/start-little-coder.sh   (or the Desktop entry with --desktop)"
say "Models: little-coder --list-models"
say "Note:   start-little-coder.sh wraps a machine-specific transport script;"
say "        point LC_TRANSPORT at yours (it states the path it expects if missing)."
