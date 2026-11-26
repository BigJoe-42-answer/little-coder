// pi update check.
// This build is not published as `little-coder`, so we never check the
// little-coder package itself — updating it would clobber this custom
// install. We poll the npm registry for a newer published pi
// (@earendil-works/pi-coding-agent) and (in TTY mode) offer to install it in
// place under the little-coder install root before the agent starts. Cached
// so we don't call out on every invocation. Best-effort throughout: if
// anything fails, we skip silently — never block the agent over a version
// check.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const REGISTRY = "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // 12 h
const FETCH_TIMEOUT_MS = 2000;
const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 1000; // auto-continue after 10s (issue #64)

// How long to wait for a Y/n answer at the interactive update prompt before
// auto-continuing WITHOUT updating, so a launch is never blocked indefinitely
// on an unattended terminal (issue #64). Configurable via
// LITTLE_CODER_UPDATE_PROMPT_TIMEOUT (seconds); "0" / "off" / "never" waits
// forever (the pre-#64 behavior). Non-numeric → default.
export function promptTimeoutMs(env = process.env) {
  const raw = env.LITTLE_CODER_UPDATE_PROMPT_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PROMPT_TIMEOUT_MS;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "off" || v === "never") return 0;
  const secs = Number(v);
  if (!Number.isFinite(secs) || secs < 0) return DEFAULT_PROMPT_TIMEOUT_MS;
  return Math.round(secs * 1000);
}

export function cachePath() {
  const xdg = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim();
  const base = xdg ? xdg : join(homedir(), ".cache");
  return join(base, "little-coder", "version-check.json");
}

// Where the updater appends the full npm transcript. The interactive update
// runs in the launcher's terminal, which can close before a failure message is
// readable — the log makes every upgrade attempt diagnosable after the fact.
export function updateLogPath() {
  return join(dirname(cachePath()), "update.log");
}

// Append one transcript to the update log, then enforce two bounds:
// - mode 600: the log holds npm's full output (registry URLs, install tree);
//   the default 644 in a shared ~/.cache would leave it world-readable. The
//   chmod runs on every append, so a log created before this fix gets
//   tightened too, not just new files.
// - size: each append starts with a "\n===== <ts> …" header, so once the file
//   passes LOG_MAX_BYTES we keep only the last LOG_KEEP_TRANSCRIPTS blocks.
// The update-notice extension (/update path) duplicates this helper — it
// cannot import from bin/ cleanly; keep the two in sync (same constants).
const LOG_MAX_BYTES = 256 * 1024;
const LOG_KEEP_TRANSCRIPTS = 20;

export function appendUpdateLog(log, text) {
  appendFileSync(log, text, { mode: 0o600 });
  try {
    chmodSync(log, 0o600);
    if (statSync(log).size > LOG_MAX_BYTES) {
      const all = readFileSync(log, "utf-8").split("\n===== ");
      const head = all.shift(); // anything before the first header, usually ""
      const kept = all.slice(-LOG_KEEP_TRANSCRIPTS);
      writeFileSync(log, head + kept.map((b) => "\n===== " + b).join(""), {
        mode: 0o600,
      });
    }
  } catch {
    // trimming is best-effort; a failed trim must not mask the update result
  }
}

export function readCache(now = Date.now()) {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data.checkedAt !== "number" || typeof data.latest !== "string") return null;
    if (now - data.checkedAt > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeCache(latest, now = Date.now()) {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ checkedAt: now, latest }));
  } catch {
    // best-effort; permission errors etc. are not fatal
  }
}

// Accept only a well-formed X.Y.Z[-prerelease] version. The npm registry always
// serves valid semver, so this rejects nothing legitimate — it refuses a
// malformed or hostile `latest` before it reaches compareSemver (which would do
// NaN math on it) or the Windows self-update sink `cmd.exe /c npm install
// @earendil-works/pi-coding-agent@<latest>`, where a shell metacharacter in the
// version string would otherwise be re-parsed by cmd.exe as a chained command.
export function isSemver(v) {
  return typeof v === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);
}

// Compare semver strings. Only handles X.Y.Z[-pre]. Returns 1 if a > b,
// -1 if a < b, 0 if equal. Pre-release suffixes are treated as < release.
export function compareSemver(a, b) {
  const parse = (v) => {
    // Split at the FIRST hyphen only: a prerelease tag may itself contain
    // hyphens (`1.0.0-rc-1`), and split("-", 2) would truncate its tail.
    const s = String(v);
    const h = s.indexOf("-");
    const core = h < 0 ? s : s.slice(0, h);
    const pre = h < 0 ? "" : s.slice(h + 1);
    const parts = core.split(".").map((n) => parseInt(n, 10));
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      pre: pre || "",
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  // Equal core: a release beats a pre-release.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

async function fetchLatest() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return isSemver(json?.version) ? json.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Decide whether to skip the check entirely. Errs toward NOT prompting in
// any context that smells programmatic.
export function shouldSkip(argv = process.argv.slice(2), env = process.env, stdout = process.stdout) {
  if (env.LITTLE_CODER_NO_UPDATE_CHECK === "1") return true;
  if (env.CI === "true" || env.CI === "1") return true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-update-check") return true;
    if (a === "--help" || a === "-h") return true;
    if (a === "--version" || a === "-v") return true;
    if (a === "--list-models") return true;
    if (a === "--export") return true;
    if (a === "--mode") {
      const next = argv[i + 1];
      if (next === "rpc" || next === "json") return true;
    }
  }
  // Non-TTY runs: scripts, pipes, --print pipelines. Notice only, no prompt.
  if (!stdout.isTTY) return "notice-only";
  return false;
}

function promptYesNo(question, timeoutMs = 0) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        rl.close();
        process.stderr.write("\n   No response — continuing without updating.\n\n");
        resolve(false);
      }, timeoutMs);
      // Don't let a pending countdown keep the event loop alive on its own.
      if (typeof timer.unref === "function") timer.unref();
    }
    rl.question(question, (answer) => {
      if (timer) clearTimeout(timer);
      rl.close();
      const a = (answer ?? "").trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

// Returns `true` if the launcher should NOT proceed to spawn pi (because we
// updated and exited / the user opted out and we should re-run).  Returns
// `false` to let the launcher continue.
//
// currentVersion — the version of the bundled pi runtime we actually spawn
//   (pi's own package.json version, not little-coder's).
//
// opts.force — bypass the 12h cache and always fetch the latest version from
//   the registry. Used when the user explicitly passes `--update`. If already
//   at the latest version, prints a short "up to date" notice instead of
//   silently returning.
//
// opts.pkgRoot — little-coder's install root. The update installs the new pi
//   in place under it (`npm install --prefix <pkgRoot> …`), touching only the
//   pi dependency — never the little-coder package itself.
//
// Trust model for the version string: with force off, the install targets
// whatever the 12 h cache says without re-fetching — the cached value passed
// isSemver on the way in, and npm verifies tarball integrity (lockfile
// hashes) at install time, so there is no separate audit step by design.
export async function checkForUpdate(currentVersion, opts = {}) {
  const skip = opts.skip ?? shouldSkip();
  if (skip === true) return false;

  const force = opts.force ?? false;
  let latest = (!force && readCache()?.latest) || null;
  if (!latest) {
    latest = await fetchLatest();
    if (latest) writeCache(latest);
  }
  if (!latest) return false;
  if (compareSemver(latest, currentVersion) <= 0) {
    if (force) {
      process.stderr.write(`\n   ✓ pi is already up to date (v${currentVersion}).\n\n`);
    }
    return false;
  }

  // Surface the available version to the running pi process (the update-notice
  // extension reads this to show an in-UI banner + enable /update) whether or
  // not the user updates now. Cleared implicitly on a successful update below,
  // since that path exits and the relaunched, up-to-date binary won't set it.
  process.env.LITTLE_CODER_UPDATE_AVAILABLE = latest;

  const headline =
    `\n📦 pi v${latest} is available (you have v${currentVersion}).`;

  if (skip === "notice-only") {
    process.stderr.write(
      `${headline}\n   Update with: npm install --ignore-scripts --no-package-lock --save-exact --prefix ${opts.pkgRoot} @earendil-works/pi-coding-agent@latest\n\n`,
    );
    return false;
  }

  const timeoutMs = opts.promptTimeoutMs ?? promptTimeoutMs();
  const timeoutHint = timeoutMs > 0 ? ` (auto-continues in ${Math.round(timeoutMs / 1000)}s)` : "";
  process.stderr.write(`${headline}\n`);
  const wantsUpdate = await promptYesNo(`   Update now? [Y/n]${timeoutHint} `, timeoutMs);
  if (!wantsUpdate) {
    process.stderr.write("   Skipping update for this run.\n\n");
    return false;
  }

  // --ignore-scripts blocks any preinstall/install/postinstall lifecycle
  // hooks from running during the upgrade — the entry vector Shai Hulud-style
  // worms (and any other npm-postinstall malware) use to land arbitrary code
  // execution as soon as a compromised version of pi (or one of its
  // transitive deps) is published. pi takes the same posture upstream (issue
  // #50 cites their config.ts).
  //
  // --no-package-lock sidesteps an npm arborist crash this fork hits
  // ("Cannot read properties of null (reading 'name')" in Link.matches):
  // re-resolving an existing package-lock.json while the `overrides` map
  // points node-domexception at file:./vendor/node-domexception throws before
  // anything installs. The lock is refreshed by hand after an upgrade.
  //
  // --save-exact keeps the dependency pin exact. A bare
  // `npm install pi@1.6.1` rewrites package.json to `^1.6.1` — observed here
  // after one e2e run — and the next plain `npm install` would then pull an
  // anchor-unaudited pi minor, the exact drift the pin exists to prevent.
  const npmArgs = [
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    "--save-exact",
    "--prefix",
    opts.pkgRoot,
    `@earendil-works/pi-coding-agent@${latest}`,
  ];
  // Capture npm's output instead of inheriting stdio: the whole transcript is
  // appended to updateLogPath(), so a terminal window that closes on exit
  // still leaves a readable record. The failure path echoes the tail inline.
  const log = updateLogPath();
  process.stderr.write(
    `\n   Running: npm ${npmArgs.join(" ")}\n   (npm output → ${log})\n\n`,
  );
  // On Windows `npm` resolves to `npm.cmd`, a batch-file shim that Node's
  // spawnSync cannot execute without shell:true. However, shell:true with
  // array args triggers DEP0190 on Node 24+. Instead, invoke cmd.exe directly
  // via COMSPEC — it resolves `npm` to `npm.cmd` itself, no shell:true needed.
  const result = process.platform === "win32"
    ? spawnSync(process.env.COMSPEC || "cmd.exe", ["/c", "npm", ...npmArgs], { encoding: "utf-8" })
    : spawnSync("npm", npmArgs, { encoding: "utf-8" });
  try {
    mkdirSync(dirname(log), { recursive: true });
    appendUpdateLog(
      log,
      `\n===== ${new Date().toISOString()} npm ${npmArgs.join(" ")} =====\n` +
        `exit: ${result.status ?? `spawn error: ${result.error?.message ?? "unknown"}`}\n` +
        `--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}\n`,
    );
  } catch {
    // logging is best-effort; never mask the update result over it
  }
  if (result.status === 0) {
    // The launcher re-execs itself from here (issue #66) so the child spawns
    // the freshly-installed pi — we don't tell the user to re-run by hand; it
    // prints "Relaunching little-coder…" next. If that re-exec can't start,
    // the launcher falls back to a manual-relaunch hint.
    process.stderr.write(`\n   ✓ Updated pi to v${latest}.\n`);
    return true;
  }
  const exitDesc = result.error
    ? `could not launch npm (${result.error.code ?? result.error.message})`
    : `npm exit ${result.status}`;
  const tail = (result.stderr || result.stdout || "")
    .trim()
    .split("\n")
    .slice(-12)
    .join("\n");
  if (tail) process.stderr.write(`\n${tail}\n`);
  process.stderr.write(
    `\n   ✗ Update failed (${exitDesc}). Full npm output: ${log}\n` +
      `   Continuing with pi v${currentVersion}.\n\n`,
  );
  return false;
}
