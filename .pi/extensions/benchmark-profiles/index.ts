import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Port of local/config.py::MODEL_PROFILES + get_model_profile with
// benchmark_overrides. Reads the `little_coder` settings block from the
// package's .pi/settings.json and then merges the user-level settings files
// over it (see settingsCandidatePaths), applies the matching per-model profile
// (plus benchmark_overrides when LITTLE_CODER_BENCHMARK=terminal_bench|gaia is
// set), and publishes the resolved values on event.systemPromptOptions
// .littleCoder so the other extensions (skill-inject, knowledge-inject,
// thinking-budget, turn-cap) read them from a single source of truth.
//
// Context budget: `contextLimit` is NOT a hardcoded settings value — it
// follows the model's live registered window (ctx.model.contextWindow, the
// same window pi shows and read-guard/getContextUsage use), so bumping a
// model's contextWindow in models.json propagates everywhere. An explicit
// per-profile/benchmark `context_limit` (e.g. gaia) still wins, and
// CONTEXT_FALLBACK (32768) is the last resort when no window is known.

interface ModelProfile {
  context_limit?: number;
  max_tokens?: number;
  thinking_budget?: number;
  skill_token_budget?: number;
  knowledge_token_budget?: number;
  system_prompt_budget?: number;
  max_retries?: number;
  temperature?: number;
  max_turns?: number;
  prefer_text_tools?: boolean;
  benchmark_overrides?: Record<string, Partial<ModelProfile>>;
}

interface LittleCoderSettings {
  default_model_profile?: ModelProfile;
  model_profiles?: Record<string, ModelProfile>;
  [key: string]: unknown;
}

let settings: LittleCoderSettings | null = null;
let loaded = false;

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Merge an overlay settings block over a base one, overlay winning field-wise.
//
// Exported for testing. The merge is deliberately shallow-but-per-profile:
// `model_profiles["llamacpp/x"]` merges field by field so a user raising
// `thinking_budget` does not have to restate `temperature`, `max_tokens` and
// `benchmark_overrides` from the shipped file (and cannot accidentally drop
// them by writing a partial profile). Unknown top-level keys pass through so a
// newer schema is not silently discarded.
export function mergeLittleCoder(
  base: LittleCoderSettings,
  overlay: LittleCoderSettings,
): LittleCoderSettings {
  const out: LittleCoderSettings = { ...base };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    const baseVal = (base as Record<string, unknown>)[key];
    if (key === "model_profiles" && isRecord(baseVal) && isRecord(value)) {
      const profiles: Record<string, unknown> = { ...(baseVal) };
      for (const [pk, pv] of Object.entries(value)) {
        profiles[pk] = isRecord(pv) && isRecord(profiles[pk])
          ? { ...(profiles[pk]), ...pv }
          : pv;
      }
      out.model_profiles = profiles as Record<string, ModelProfile>;
    } else if (key === "default_model_profile" && isRecord(baseVal) && isRecord(value)) {
      out.default_model_profile = {
        ...(baseVal as ModelProfile),
        ...(value as ModelProfile),
      };
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Settings files, lowest precedence first. The package's own copy is the
// baseline; pi's agent dir and little-coder's config home may override it.
// Both user paths honour the env vars the launcher itself honours
// (`PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME`) — hard-coding `~/.pi/agent` would
// miss anyone who moved the agent dir, which is exactly the audience trying to
// override a profile.
export function settingsCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? "";
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(repoRoot(), ".pi", "settings.json"),
    join(agentDir, "settings.json"),
    join(configHome, "little-coder", "settings.json"),
  ];
}

// Read + merge every candidate. Exported for testing so the merge can be
// exercised against real files without poking the module-level cache.
export function loadSettingsFrom(paths: string[]): LittleCoderSettings | null {
  let merged: LittleCoderSettings | null = null;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      // Loud, not silent: a malformed settings file used to be indistinguishable
      // from "your profile does not apply".
      console.error(`benchmark-profiles: ignoring malformed JSON in ${p}`);
      continue;
    }
    if (!isRecord(raw) || !isRecord(raw.little_coder)) continue;
    const block = raw.little_coder as LittleCoderSettings;
    merged = merged ? mergeLittleCoder(merged, block) : { ...block };
  }
  return merged;
}

function loadSettings(): void {
  if (loaded) return;
  loaded = true;
  // Merge every candidate, later (user-level) files winning.
  //
  // This used to be first-hit-wins with a `return` inside the loop. The
  // package's own `.pi/settings.json` always exists and always carries a
  // `little_coder` block, so the first candidate always matched and every
  // user-level file was unreachable: a user could raise `thinking_budget` only
  // by editing a file inside the npm package (issue #130).
  settings = loadSettingsFrom(settingsCandidatePaths());
}

// Normalize the separator between model-name segments so a profile key written
// with hyphens (`llamacpp/qwen3.6-35b-a3b`) matches a runtime model id that uses
// a colon (`llamacpp/qwen3.6:35b-a3b`) and vice-versa. Without this the prefix
// match silently fails and EVERY model falls back to default_model_profile —
// per-model thinking_budget / context_limit / temperature are skipped (the
// quirk surfaced in issue #8's reproduction). Dots (`qwen3.6`) are preserved.
export function normKey(s: string): string {
  return s.replace(/:/g, "-");
}

// Pure resolver, exported for testing. Exact match → separator-insensitive
// prefix match → default_model_profile, then benchmark_overrides if `bench` set.
export function resolveProfileFrom(
  s: LittleCoderSettings | null,
  providerSlashModel: string,
  bench?: string,
): ModelProfile {
  if (!s) return {};
  const profiles = s.model_profiles ?? {};
  const target = normKey(providerSlashModel);

  let base: ModelProfile | undefined = profiles[providerSlashModel];
  if (!base) {
    for (const [pattern, p] of Object.entries(profiles)) {
      if (target === normKey(pattern) || target.startsWith(normKey(pattern))) {
        base = p;
        break;
      }
    }
  }
  if (!base) base = s.default_model_profile ?? {};

  const { benchmark_overrides, ...basePlain } = { ...base };
  if (bench && benchmark_overrides && benchmark_overrides[bench]) {
    return { ...basePlain, ...benchmark_overrides[bench] };
  }
  return basePlain;
}

// Last-resort context window when neither an explicit profile override nor the
// model's registered window is available (also the shipped models.json default).
export const CONTEXT_FALLBACK = 32768;

// little-coder's context budget follows the model's live registered window.
// Precedence: an explicit profile/benchmark context_limit (e.g. gaia) wins, then
// the model's registered contextWindow (provider-defined, user-overridable in
// models.json), then CONTEXT_FALLBACK. A non-positive / non-finite window is
// treated as "unknown" and falls through.
export function resolveContextLimit(
  profileContextLimit?: number,
  modelWindow?: number,
): number {
  if (typeof profileContextLimit === "number" && profileContextLimit > 0) {
    return profileContextLimit;
  }
  if (typeof modelWindow === "number" && Number.isFinite(modelWindow) && modelWindow > 0) {
    return modelWindow;
  }
  return CONTEXT_FALLBACK;
}

function resolveProfile(providerSlashModel: string): ModelProfile {
  loadSettings();
  return resolveProfileFrom(settings, providerSlashModel, process.env.LITTLE_CODER_BENCHMARK);
}

// Per-benchmark tools that should always have skill cards present on turn 1,
// even before the agent has used them. Without this, skill-inject relies on
// recency / error-recovery / intent-matching, none of which fire on the
// opening turn — and the wrong skills (Edit/Write) can win the budget on a
// pure research question.
const BENCHMARK_REQUIRED_TOOLS: Record<string, string[]> = {
  gaia: ["BrowserNavigate", "BrowserExtract", "EvidenceAdd"],
};

function toLittleCoderOptions(p: ModelProfile): Record<string, unknown> {
  const benchmark = process.env.LITTLE_CODER_BENCHMARK;
  const out: Record<string, unknown> = {
    contextLimit: p.context_limit,
    maxTokens: p.max_tokens,
    thinkingBudget: p.thinking_budget,
    skillTokenBudget: p.skill_token_budget,
    knowledgeTokenBudget: p.knowledge_token_budget,
    systemPromptBudget: p.system_prompt_budget,
    maxRetries: p.max_retries,
    temperature: p.temperature,
    maxTurns: p.max_turns,
    preferTextTools: p.prefer_text_tools,
    benchmark,
  };
  if (benchmark && BENCHMARK_REQUIRED_TOOLS[benchmark]) {
    out.requiredTools = BENCHMARK_REQUIRED_TOOLS[benchmark];
  }
  return out;
}

// Providers whose servers accept a `temperature` field on chat-completions.
// little-coder's temperature defaults are tuned for the local-server case;
// hosted reasoning models (Copilot's gpt-5.x, OpenAI o-series) hard-reject
// the parameter with a 400 (issue #33). The list is intentionally minimal:
// llama.cpp-style local servers. Override at runtime via
// LITTLE_CODER_TEMPERATURE_PROVIDERS=foo,bar to add your own local provider.
const DEFAULT_TEMPERATURE_PROVIDERS = ["llamacpp", "ollama", "lmstudio"] as const;

export function providerAcceptsTemperature(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.LITTLE_CODER_TEMPERATURE_PROVIDERS;
  const list = override
    ? override.split(",").map((s) => s.trim()).filter(Boolean)
    : (DEFAULT_TEMPERATURE_PROVIDERS as readonly string[]);
  return list.includes(provider);
}

export default function (pi: ExtensionAPI) {
  // Shared across handlers so before_provider_request can re-read the most
  // recently resolved temperature without re-parsing settings every turn.
  let resolvedTemperature: number | undefined;
  // Provider-level guard: hosted reasoning models reject `temperature` (see
  // DEFAULT_TEMPERATURE_PROVIDERS above).
  let temperatureAccepted = false;

  pi.on("before_agent_start", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const key = `${model.provider}/${model.id}`;
    const profile = resolveProfile(key);

    const opts: any = (event as any).systemPromptOptions ?? {};
    const existing = opts.littleCoder ?? {};
    const resolved = toLittleCoderOptions(profile);

    // Merge; existing (set by other extensions earlier) wins over defaults
    // from this profile, but undefined existing values fall back.
    opts.littleCoder = { ...resolved, ...existing };
    // Re-copy so undefined existing values don't overwrite resolved values
    for (const [k, v] of Object.entries(resolved)) {
      if (opts.littleCoder[k] === undefined) opts.littleCoder[k] = v;
    }

    // Context budget follows the model's live registered window (the same
    // window pi displays and read-guard reads), not a hardcoded settings value.
    // An explicit profile/benchmark context_limit still wins; 32k is the floor.
    const modelWindow = Number((model as any)?.contextWindow);
    opts.littleCoder.contextLimit = resolveContextLimit(profile.context_limit, modelWindow);

    resolvedTemperature = opts.littleCoder.temperature;
    temperatureAccepted = providerAcceptsTemperature(model.provider);
  });

  // Inject the profile's temperature onto the outgoing provider payload.
  // Without this, pi-ai uses the provider default (typically ~0.8 for
  // llama.cpp), which adds measurable stochastic variance on hard
  // algorithmic exercises. Matches local-coder's profiles[].temperature=0.3.
  //
  // Skipped for providers whose servers reject `temperature` (Copilot's
  // gpt-5.x, OpenAI's o-series) — see providerAcceptsTemperature.
  //
  // IMPORTANT: pi's runner passes payload by reference but only adopts
  // *returned* values. Mutating in place is discarded between handlers, so
  // we build a new payload object and return it explicitly.
  pi.on("before_provider_request", async (event) => {
    if (!temperatureAccepted) return;
    if (resolvedTemperature === undefined) return;
    const payload: any = (event as any).payload;
    if (!payload || typeof payload !== "object") return;
    return { ...payload, temperature: resolvedTemperature };
  });
}
