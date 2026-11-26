import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// In-app update surfacing (issue #64, items 2 & 3).
//
// This build is not published as `little-coder`, so the launcher's pre-flight
// update check (bin/update-check.mjs) polls npm for a newer *pi*
// (@earendil-works/pi-coding-agent) instead of a newer little-coder, and
// exports that version via LITTLE_CODER_UPDATE_AVAILABLE. This extension
// consumes that:
//   2. shows a one-line "update available" notice inside the running TUI, so a
//      user who dismissed / timed out of the launcher prompt still knows; and
//   3. registers `/update` to install the latest pi in place and cleanly end
//      the session for a restart — no need to quit, remember the npm
//      incantation, and relaunch.
//
// Registering `/update` unconditionally (even with no pending update) is
// deliberate: it doubles as a manual "pull the latest pi" command. When a
// version is known from the launcher we pin to it; otherwise we install
// `@latest`.

// little-coder's install root: this extension lives at
// <pkgRoot>/.pi/extensions/update-notice/index.ts, so three levels up is the
// package root that `npm install --prefix` needs to update the bundled pi in
// place (touching only the pi dependency, never the little-coder package).
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Exported for unit tests: build the npm argv used to upgrade pi in place.
// Mirrors the launcher's --ignore-scripts posture (issue #50 — block
// postinstall as a supply-chain landing spot on upgrade).
export function upgradeArgs(latest?: string, pkgRoot: string = PKG_ROOT) {
  const spec = latest
    ? `@earendil-works/pi-coding-agent@${latest}`
    : "@earendil-works/pi-coding-agent@latest";
  // --no-package-lock sidesteps an npm arborist crash this fork hits when
  // re-resolving the lock with the file:./vendor/node-domexception override
  // (same rationale as bin/update-check.mjs).
  return ["install", "--ignore-scripts", "--no-package-lock", "--prefix", pkgRoot, spec];
}

// Same log file the launcher's updater writes to (~/.cache/little-coder/
// update.log): the full npm transcript, so a failure is still readable after
// the TUI closes or the notify line scrolls away.
function updateLogPath(): string {
  const xdg = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim();
  const base = xdg ? xdg : join(homedir(), ".cache");
  return join(base, "little-coder", "update.log");
}

// Mirrors appendUpdateLog() in bin/update-check.mjs (mode 600 + keep the last
// N transcripts once the file passes 256 KB) — this extension cannot import
// from bin/ cleanly, so the two copies must stay in sync. Same constants.
const LOG_MAX_BYTES = 256 * 1024;
const LOG_KEEP_TRANSCRIPTS = 20;

function appendUpdateLog(log: string, text: string): void {
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
    // trimming is best-effort; never mask the update result over it
  }
}

export default function (pi: ExtensionAPI) {
  const available = process.env.LITTLE_CODER_UPDATE_AVAILABLE;

  if (available) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        `pi v${available} is available — run /update to install it (then restart)`,
        "info",
      );
    });
  }

  pi.registerCommand("update", {
    description: "Install the latest pi runtime in place and end this session so you can restart into it",
    handler: async (_args, ctx) => {
      const latest = process.env.LITTLE_CODER_UPDATE_AVAILABLE;
      const ok = await ctx.ui.confirm(
        `Update pi${latest ? ` to v${latest}` : " to the latest version"}?`,
        "This ends the current session — you'll relaunch little-coder to use the new pi.",
      );
      if (!ok) return;

      ctx.ui.notify("updating pi… (this can take a moment)", "info");
      const args = upgradeArgs(latest);
      // On Windows `npm` is a .cmd shim spawnSync can't exec directly; go via
      // COMSPEC (same rationale as the launcher). Capture output rather than
      // inherit so npm's noise doesn't fight pi's TUI; we surface a summary.
      const result =
        process.platform === "win32"
          ? spawnSync(process.env.COMSPEC || "cmd.exe", ["/c", "npm", ...args], { encoding: "utf-8" })
          : spawnSync("npm", args, { encoding: "utf-8" });

      if (result.status === 0) {
        ctx.ui.notify(
          `✓ updated pi${latest ? ` to v${latest}` : ""} — relaunch little-coder to use it. Ending session…`,
          "info",
        );
        ctx.shutdown();
        return;
      }
      const why = result.error
        ? ((result.error as NodeJS.ErrnoException).code ?? result.error.message)
        : `npm exit ${result.status}`;
      // Persist the full npm transcript before notifying — the notify line is
      // easy to miss and the window may close right after.
      let logPath = "";
      try {
        logPath = updateLogPath();
        mkdirSync(dirname(logPath), { recursive: true });
        appendUpdateLog(
          logPath,
          `\n===== ${new Date().toISOString()} npm ${args.join(" ")} (/update) =====\n` +
            `exit: ${result.status ?? `spawn error: ${(result.error as Error)?.message ?? "unknown"}`}\n` +
            `--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}\n`,
        );
      } catch {
        logPath = ""; // logging is best-effort
      }
      ctx.ui.notify(
        `✗ update failed (${why}). ${logPath ? `Full npm output: ${logPath}. ` : ""}` +
          `Run manually: npm install --ignore-scripts --no-package-lock --prefix ${PKG_ROOT} @earendil-works/pi-coding-agent@latest`,
        "error",
      );
    },
  });
}
