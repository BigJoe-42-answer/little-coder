import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyPiPatches, resolvePiRoot, patchFilesFor, PATCHES, repairJsonControlChars } from "./patch-pi.mjs";

// These tests are the upgrade safety-net for our pi source patches.
//
// A source patch can silently stop suppressing pi's UI marker when pi is
// upgraded (the surrounding code shifts and the patch no-ops). We never want
// that to be a silent production regression — so this test FAILS the moment the
// installed pi no longer matches what a patch expects, telling us to refresh
// exactly one string in patch-pi.mjs. A pi bump becomes a loud CI failure, not
// a quiet cosmetic regression for users.

describe("pi runtime patches", () => {
  it("resolves the installed pi package root", () => {
    expect(resolvePiRoot(), "could not locate @earendil-works/pi-coding-agent").toBeTruthy();
  });

  it("applies cleanly and is idempotent", () => {
    // Idempotent: safe to run repeatedly (every launch + tests). There is no
    // postinstall any more — little-coder ships no npm install scripts (#75).
    const piRoot = resolvePiRoot();
    // A patch is "needed" when some file it targets carries either the
    // original block (unpatched) or our marker (patched by an earlier run).
    // Glob patches (bundle chunks) match many files but only one carries the
    // code, hence the some() over files.
    const needed = PATCHES.map((p) =>
      patchFilesFor(p, piRoot).some((f) => {
        const src = readFileSync(f, "utf8");
        return src.includes(p.find) || src.includes(p.applied);
      }),
    );
    applyPiPatches();
    applyPiPatches();
    PATCHES.forEach((p, i) => {
      if (!needed[i]) return; // pi no longer ships this block at all
      const files = patchFilesFor(p, piRoot);
      expect(
        files.some((f) => readFileSync(f, "utf8").includes(p.applied)),
        `expected patch marker somewhere in ${p.rel} after applying`,
      ).toBe(true);
    });
  });

  it("leaves no un-suppressed original block (loud signal to refresh on pi upgrade)", () => {
    applyPiPatches();
    const piRoot = resolvePiRoot();
    for (const p of PATCHES) {
      for (const file of patchFilesFor(p, piRoot)) {
        const src = readFileSync(file, "utf8");
        // After applying, the original block must be gone — either we replaced it,
        // or this pi version no longer ships it. If pi changed *around* the block
        // so our patch silently no-op'd, the original is still present → fail.
        expect(
          src.includes(p.find),
          `pi patch for "${p.rel}" no longer applies — pi likely changed. ` +
            `Refresh the find/replace in scripts/patch-pi.mjs for the new pi version.`,
        ).toBe(false);
      }
    }
  });

  it("the patched file no longer renders the bare \"Operation aborted\" string", () => {
    applyPiPatches();
    const piRoot = resolvePiRoot();
    const file = join(piRoot, PATCHES[0].rel);
    const src = readFileSync(file, "utf8");
    // The literal only survives inside our explanatory comment, never as the
    // rendered fallback (`: "Operation aborted";`).
    expect(src.includes(': "Operation aborted";')).toBe(false);
    // Same check for the minified bundle copy the bin actually runs. Note the
    // literal also appears in unrelated tool-result strings, so anchor on the
    // assistant-message fallback shape specifically.
    for (const f of patchFilesFor(PATCHES[1], piRoot)) {
      const bsrc = readFileSync(f, "utf8");
      expect(bsrc.includes(':"Operation aborted";this.contentContainer')).toBe(false);
    }
  });
});

// ── issue #127: raw control characters in a JSON-string `edits` ─────────────
describe("edit-tool JSON repair (issue #127)", () => {
  // The exact payload shape brlucasdx reported: a model writes the replacement
  // as multi-line code, so the JSON string carries literal newlines.
  const RAW = '[{"oldText": "def parse(text):\n    pass", "newText": "def parse(text):\n    return 1"}]';

  it("the unrepaired payload is what JSON.parse actually rejects", () => {
    expect(() => JSON.parse(RAW)).toThrow(/control character/i);
  });

  it("escapes control chars inside strings and preserves the newlines", () => {
    const parsed = JSON.parse(repairJsonControlChars(RAW));
    expect(parsed).toEqual([
      { oldText: "def parse(text):\n    pass", newText: "def parse(text):\n    return 1" },
    ]);
  });

  it("leaves structural whitespace between tokens alone", () => {
    // The newline here is NOT inside a string literal, so it must survive as
    // structural whitespace rather than become a literal \n in a value.
    const out = repairJsonControlChars('{\n  "a": "b"\n}');
    expect(out).toBe('{\n  "a": "b"\n}');
    expect(JSON.parse(out)).toEqual({ a: "b" });
  });

  it("does not let an escaped quote flip it out of the string", () => {
    // `\"` inside a value is ordinary in code being edited; treating it as a
    // string terminator would leave the following newline unescaped.
    const out = repairJsonControlChars('{"a": "say \\"hi\\"\nthen stop"}');
    expect(JSON.parse(out)).toEqual({ a: 'say "hi"\nthen stop' });
  });

  it("is a no-op on already-valid JSON", () => {
    const valid = '[{"oldText":"a\\nb","newText":"c"}]';
    expect(repairJsonControlChars(valid)).toBe(valid);
  });

  it("pi's own edit tool recovers the array after patching", async () => {
    applyPiPatches();
    const piRoot = resolvePiRoot();
    const tools = await import(
      pathToFileURL(join(piRoot, "dist/core/tools/index.js")).href
    );
    const prepared = tools.createEditTool(process.cwd()).prepareArguments({
      path: "x.py",
      edits: RAW,
    });
    expect(Array.isArray(prepared.edits), "edits should have been repaired into an array").toBe(true);
    expect(prepared.edits[0].newText).toBe("def parse(text):\n    return 1");
  });
});
