// @ts-check
import tseslint from "typescript-eslint";

// Type-checked lint for the extension layer — the same set `npm run typecheck`
// covers (tsconfig include), so the two gates can never drift. bin/ and
// scripts/ are plain .mjs (no types to check); benchmarks/ is Python.
//
// Scope decision (fork quality review, 2026-11-26): the first run of
// recommendedTypeChecked reported 2372 errors, ~1970 of them from the
// `any`-boundary family. The extension layer deliberately types the pi
// boundary as `any` (duck-typed ExtensionAPI, event payloads, test fakes)
// and 156 `as any` casts sit at that seam. Typing the whole seam is a
// separate, large refactor; pretending it is done by mass-disabling inline
// would hide the real count. So the six `any`-family rules are off HERE, at
// the top level, with the count they cover recorded — one honest number in
// one place, re-checkable by flipping the rule, instead of 1970 scattered
// eslint-disable comments. Everything else in recommendedTypeChecked is
// enforced in CI.
//
// Long-term path: type the pi boundary (ExtensionAPI is typed upstream; most
// `any`s are local convenience), then re-enable these rules one at a time.
export default tseslint.config(
  {
    files: [".pi/extensions/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The documented `any` seam (see header). ~1970 findings at adoption:
      // 636 no-unsafe-member-access, 435 no-explicit-any, 270
      // no-unsafe-assignment, 220 no-unsafe-call, 121 no-unsafe-argument,
      // 46 no-unsafe-return.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Still enforced for typed values (stringifying objects, etc.); any is
      // allowed because the boundary itself is `any` by the six rules above.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowAny: true },
      ],
      // pi's ExtensionHandler contract is async; handlers stay async for
      // symmetry with the API even when the body has nothing to await.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Config file itself (plain JS, not in the tsconfig project).
    files: ["eslint.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
