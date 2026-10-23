import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import benchmarkProfiles, {
  resolveProfileFrom,
  normKey,
  resolveContextLimit,
  mergeLittleCoder,
  loadSettingsFrom,
  settingsCandidatePaths,
  CONTEXT_FALLBACK,
  providerAcceptsTemperature,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(here, "..", "..", "settings.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

describe("benchmark-profiles resolution against real settings.json", () => {
  const settings = readJson(settingsPath).little_coder;

  it("resolves base profile for llamacpp/qwen3.6-35b-a3b (budget bumped to 4096)", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b");
    expect(p.thinking_budget).toBe(4096);
    // base profiles no longer hardcode context_limit — it derives from the
    // model's live registered window at runtime (see resolveContextLimit).
    expect(p.context_limit).toBeUndefined();
    expect(p.max_turns).toBeUndefined();
  });

  it("applies terminal_bench overrides", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b", "terminal_bench");
    expect(p.thinking_budget).toBe(3000); // benchmark override kept
    expect(p.temperature).toBe(0.2);
    expect(p.max_turns).toBe(40);
    expect(p.context_limit).toBeUndefined(); // no override → live model window
  });

  it("applies gaia overrides", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b", "gaia");
    expect(p.thinking_budget).toBe(2000);
    expect(p.temperature).toBe(0.4);
    expect(p.max_turns).toBe(40);
    expect(p.context_limit).toBe(65536);
  });

  it("unknown model falls back to default_model_profile (also 4096)", () => {
    const p = resolveProfileFrom(settings, "fake-provider/fake-model");
    expect(p.thinking_budget).toBe(4096);
    expect(p.context_limit).toBeUndefined();
  });

  it("unknown benchmark name yields base profile unchanged", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b", "totally_made_up");
    expect(p.thinking_budget).toBe(4096);
    expect(p.max_turns).toBeUndefined();
  });

  it("every shipped per-model profile carries the 4096 budget", () => {
    for (const key of Object.keys(settings.model_profiles)) {
      expect(resolveProfileFrom(settings, key).thinking_budget, key).toBe(4096);
    }
  });
});

describe("separator-insensitive model-key matching (issue #8 quirk)", () => {
  // The reproduction noted runtime ids using a colon (`qwen3.6:35b-a3b`) never
  // matched the hyphenated profile key, so per-model profiles were silently
  // skipped and everything fell back to default.
  const settings = {
    default_model_profile: { thinking_budget: 4096 },
    model_profiles: {
      "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 1234, temperature: 0.3 },
    },
  };

  it("normKey collapses ':' to '-'", () => {
    expect(normKey("llamacpp/qwen3.6:35b-a3b")).toBe("llamacpp/qwen3.6-35b-a3b");
  });

  it("matches a colon runtime id to a hyphenated profile key", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6:35b-a3b");
    expect(p.thinking_budget).toBe(1234); // per-model profile, NOT the default
  });

  it("still matches the exact hyphenated id", () => {
    expect(resolveProfileFrom(settings, "llamacpp/qwen3.6-35b-a3b").thinking_budget).toBe(1234);
  });

  it("matches via prefix when the runtime id has a tag suffix", () => {
    const p = resolveProfileFrom(settings, "llamacpp/qwen3.6:35b-a3b:Q4_K_M");
    expect(p.thinking_budget).toBe(1234);
  });

  it("an unrelated model still falls back to default", () => {
    expect(resolveProfileFrom(settings, "ollama/llama3").thinking_budget).toBe(4096);
  });
});

describe("resolveContextLimit", () => {
  it("uses the model's live registered window when no profile override", () => {
    expect(resolveContextLimit(undefined, 131072)).toBe(131072);
    expect(resolveContextLimit(undefined, 32768)).toBe(32768);
  });
  it("an explicit profile/benchmark context_limit wins over the model window", () => {
    expect(resolveContextLimit(65536, 131072)).toBe(65536);
  });
  it("falls back to CONTEXT_FALLBACK when neither is known", () => {
    expect(resolveContextLimit(undefined, undefined)).toBe(CONTEXT_FALLBACK);
    expect(resolveContextLimit(undefined, 0)).toBe(CONTEXT_FALLBACK);
    expect(resolveContextLimit(undefined, Number.NaN)).toBe(CONTEXT_FALLBACK);
    expect(CONTEXT_FALLBACK).toBe(32768);
  });
});

// End-to-end: the before_agent_start handler must publish contextLimit from the
// live model.contextWindow against the REAL shipped settings.json.
describe("before_agent_start publishes a model-window contextLimit", () => {
  function fireWith(model: any, benchmark?: string) {
    const prev = process.env.LITTLE_CODER_BENCHMARK;
    if (benchmark) process.env.LITTLE_CODER_BENCHMARK = benchmark;
    else delete process.env.LITTLE_CODER_BENCHMARK;
    try {
      const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
      const pi = { on: (n: string, h: any) => ((handlers[n] ??= []).push(h)) };
      benchmarkProfiles(pi as any);
      const event: any = { systemPromptOptions: {} };
      const ctx: any = { model };
      for (const h of handlers["before_agent_start"] ?? []) h(event, ctx);
      return event.systemPromptOptions.littleCoder;
    } finally {
      if (prev === undefined) delete process.env.LITTLE_CODER_BENCHMARK;
      else process.env.LITTLE_CODER_BENCHMARK = prev;
    }
  }

  it("follows the model's contextWindow for a normal (non-benchmark) run", () => {
    const lc = fireWith({ provider: "llamacpp", id: "qwen3.6-35b-a3b", contextWindow: 131072 });
    expect(lc.contextLimit).toBe(131072);
  });

  it("falls back to 32768 when the model reports no usable window", () => {
    const lc = fireWith({ provider: "llamacpp", id: "qwen3.6-35b-a3b", contextWindow: 0 });
    expect(lc.contextLimit).toBe(32768);
  });

  it("an explicit gaia override still wins over the live window", () => {
    const lc = fireWith(
      { provider: "llamacpp", id: "qwen3.6-35b-a3b", contextWindow: 131072 },
      "gaia",
    );
    expect(lc.contextLimit).toBe(65536);
  });
});

describe("providerAcceptsTemperature (issue #33)", () => {
  it("accepts the shipped local providers by default", () => {
    expect(providerAcceptsTemperature("llamacpp", {})).toBe(true);
    expect(providerAcceptsTemperature("ollama", {})).toBe(true);
    expect(providerAcceptsTemperature("lmstudio", {})).toBe(true);
  });
  it("rejects hosted reasoning providers that 400 on temperature", () => {
    expect(providerAcceptsTemperature("copilot", {})).toBe(false);
    expect(providerAcceptsTemperature("openai", {})).toBe(false);
    expect(providerAcceptsTemperature("anthropic", {})).toBe(false);
  });
  it("LITTLE_CODER_TEMPERATURE_PROVIDERS env replaces the default list", () => {
    const env = { LITTLE_CODER_TEMPERATURE_PROVIDERS: "vllm, my-local" };
    expect(providerAcceptsTemperature("vllm", env)).toBe(true);
    expect(providerAcceptsTemperature("my-local", env)).toBe(true);
    expect(providerAcceptsTemperature("llamacpp", env)).toBe(false);
  });
});

describe("before_provider_request only injects temperature for accepting providers", () => {
  async function runHandlers(model: any, payload: any) {
    const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
    const pi = { on: (n: string, h: any) => ((handlers[n] ??= []).push(h)) };
    benchmarkProfiles(pi as any);
    const startEvent: any = { systemPromptOptions: {} };
    const ctx: any = { model };
    for (const h of handlers["before_agent_start"] ?? []) await h(startEvent, ctx);
    const reqEvent: any = { payload };
    let lastResult: any;
    for (const h of handlers["before_provider_request"] ?? []) {
      lastResult = await h(reqEvent, ctx);
    }
    return lastResult;
  }

  it("injects temperature for a local llamacpp model", async () => {
    const out = await runHandlers(
      { provider: "llamacpp", id: "qwen3.6-27b", contextWindow: 131072 },
      { messages: [] },
    );
    expect(out).toMatchObject({ temperature: 0.3 });
  });

  it("does NOT inject temperature for copilot/gpt-5.x (issue #33)", async () => {
    const out = await runHandlers(
      { provider: "copilot", id: "gpt-5.4", contextWindow: 131072 },
      { messages: [] },
    );
    expect(out).toBeUndefined();
  });
});

// ── Issue #130: user-level settings must be reachable ─────────────────────
// loadSettings() used to `return` on the first candidate that carried a
// `little_coder` block. The first candidate is the file inside the npm package,
// which always exists and always carries that block, so a user's own
// settings.json was never read: raising `thinking_budget` (or adding a profile
// for a provider the shipped file doesn't know, e.g. `strata/…`) required
// editing a root-owned file under /usr/lib that the next install erases.
describe("layered settings merge (issue #130)", () => {
  const shipped = readJson(settingsPath).little_coder;

  function tmpWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "lc-profiles-"));
    for (const [rel, body] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return dir;
  }

  it("mergeLittleCoder merges default_model_profile field-wise", () => {
    const merged = mergeLittleCoder(shipped, {
      default_model_profile: { thinking_budget: 32000 },
    });
    expect(merged.default_model_profile?.thinking_budget).toBe(32000);
    // Fields the overlay never mentioned survive: a partial profile cannot
    // silently drop the shipped temperature or skill budget.
    expect(merged.default_model_profile?.temperature).toBe(0.3);
    expect(merged.default_model_profile?.skill_token_budget).toBe(300);
  });

  it("an existing per-model profile merges field-wise and keeps benchmark_overrides", () => {
    const merged = mergeLittleCoder(shipped, {
      model_profiles: { "llamacpp/qwen3.6-35b-a3b": { thinking_budget: 8192 } },
    });
    expect(resolveProfileFrom(merged, "llamacpp/qwen3.6-35b-a3b").thinking_budget).toBe(8192);
    // Benchmark runs stay comparable: the shipped overrides were not mentioned.
    expect(resolveProfileFrom(merged, "llamacpp/qwen3.6-35b-a3b", "gaia").thinking_budget).toBe(2000);
    expect(resolveProfileFrom(merged, "llamacpp/qwen3.6-35b-a3b", "gaia").context_limit).toBe(65536);
  });

  it("a user profile for a provider the shipped file does not know is added", () => {
    const merged = mergeLittleCoder(shipped, {
      model_profiles: { "strata/iq3_s": { thinking_budget: 24000, temperature: 0.6 } },
    });
    const p = resolveProfileFrom(merged, "strata/iq3_s");
    expect(p.thinking_budget).toBe(24000);
    expect(p.temperature).toBe(0.6);
    // Untouched providers still fall back to the (merged) default profile.
    expect(resolveProfileFrom(merged, "strata/other").thinking_budget).toBe(4096);
  });

  it("later files win, and the package file is the first candidate", () => {
    const dirs = tmpWith({
      "pkg/.pi/settings.json": JSON.stringify({
        little_coder: { default_model_profile: { thinking_budget: 4096, temperature: 0.3 } },
      }),
      "agent/settings.json": JSON.stringify({
        little_coder: { default_model_profile: { thinking_budget: 12000 } },
      }),
      "xdg/little-coder/settings.json": JSON.stringify({
        little_coder: { default_model_profile: { temperature: 0.7 } },
      }),
    });
    try {
      const merged = loadSettingsFrom([
        join(dirs, "pkg/.pi/settings.json"),
        join(dirs, "agent/settings.json"),
        join(dirs, "xdg/little-coder/settings.json"),
      ])!;
      expect(merged.default_model_profile).toEqual({
        thinking_budget: 12000,
        temperature: 0.7,
      });
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
    const paths = settingsCandidatePaths({ HOME: "/home/u" } as NodeJS.ProcessEnv);
    expect(paths[0]).toBe(join(here, "..", "..", "settings.json"));
    expect(paths[1]).toBe(join("/home/u", ".pi", "agent", "settings.json"));
    expect(paths[2]).toBe(join("/home/u", ".config", "little-coder", "settings.json"));
  });

  it("honours PI_CODING_AGENT_DIR and XDG_CONFIG_HOME rather than hardcoding ~", () => {
    const paths = settingsCandidatePaths({
      HOME: "/home/u",
      PI_CODING_AGENT_DIR: "/elsewhere/agent",
      XDG_CONFIG_HOME: "/elsewhere/config",
    } as NodeJS.ProcessEnv);
    expect(paths[1]).toBe(join("/elsewhere/agent", "settings.json"));
    expect(paths[2]).toBe(join("/elsewhere/config", "little-coder", "settings.json"));
  });

  it("a malformed file is skipped, not treated as 'no settings'", () => {
    const dirs = tmpWith({
      "agent/settings.json": "{ this is not json",
      "xdg/little-coder/settings.json": JSON.stringify({
        little_coder: { default_model_profile: { thinking_budget: 9000 } },
      }),
    });
    const errors: string[] = [];
    const prev = console.error;
    console.error = (m: string) => errors.push(String(m));
    try {
      const merged = loadSettingsFrom([
        join(dirs, "agent/settings.json"),
        join(dirs, "xdg/little-coder/settings.json"),
      ])!;
      expect(merged.default_model_profile?.thinking_budget).toBe(9000);
      expect(errors.join("\n")).toMatch(/malformed JSON/);
    } finally {
      console.error = prev;
      rmSync(dirs, { recursive: true, force: true });
    }
  });

  it("a settings file with no little_coder block does not reset the merge", () => {
    const dirs = tmpWith({
      "agent/settings.json": JSON.stringify({ quietStartup: true, theme: "dark" }),
    });
    try {
      expect(loadSettingsFrom([join(dirs, "agent/settings.json")])).toBeNull();
    } finally {
      rmSync(dirs, { recursive: true, force: true });
    }
  });
});
