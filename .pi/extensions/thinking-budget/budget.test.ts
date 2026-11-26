import { describe, it, expect, beforeEach, afterEach } from "vitest";
import setupExtension, { resolveThinkingBudget } from "./index.ts";

// Exercise the char→token conversion (matches local/context_manager.py)
function charsToTokens(chars: number): number {
  return Math.ceil(chars / 3.5);
}

describe("thinking budget token estimation", () => {
  it("converts chars to tokens via /3.5", () => {
    expect(charsToTokens(0)).toBe(0);
    expect(charsToTokens(3)).toBe(1);
    expect(charsToTokens(7)).toBe(2);
    expect(charsToTokens(3500)).toBe(1000);
  });
  it("4096 tokens ~ 14336 chars (the v1.5.0 default budget)", () => {
    expect(charsToTokens(14336)).toBe(4096);
    expect(charsToTokens(14337)).toBeGreaterThan(4096);
  });
});

// ── Issue #8 regression coverage (second reproduction, 1.4.3) ───────────────
// The bug: recovery (setThinkingLevel("off") + sendUserMessage) was deferred to
// a `turn_end` handler that ran against the module-scope `pi` AFTER ctx.abort()
// triggered a session replacement → stale `pi` → throw → thinking never turned
// off + follow-up never sent.
//
// The fix: do the whole recovery synchronously in `message_update`, BEFORE
// ctx.abort(), while `pi` is still live. These tests pin that choreography:
//   - no `turn_end` handler exists (nothing can run against a stale pi),
//   - setThinkingLevel + sendUserMessage are ordered strictly before abort,
//   - thinking is re-asserted off across the restart turn,
//   - the prior level is restored on the next genuine user input.

interface Handler {
  (event: any, ctx: any): unknown;
}

function makeHarness(initialLevel = "high") {
  const calls: string[] = []; // ordered log across pi + ctx
  const followUps: string[] = [];
  const notifies: string[] = [];
  let level = initialLevel;
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    handlers,
    on(name: string, h: Handler) {
      (handlers[name] ??= []).push(h);
    },
    getThinkingLevel() {
      return level;
    },
    setThinkingLevel(l: string) {
      level = l;
      calls.push(`set:${l}`);
    },
    sendUserMessage(m: string) {
      followUps.push(m);
      calls.push("send");
    },
  };
  const ctx = {
    abort() {
      calls.push("abort");
    },
    ui: {
      notify(m: string) {
        notifies.push(m);
        calls.push("notify");
      },
    },
  };
  return {
    pi,
    ctx,
    calls,
    followUps,
    notifies,
    level: () => level,
    setLevelExternally: (l: string) => {
      level = l;
    },
  };
}

async function fire(pi: any, name: string, event: any, ctx: any) {
  for (const h of pi.handlers[name] ?? []) await h(event, ctx);
}

function thinkingDelta(s: string) {
  return { assistantMessageEvent: { type: "thinking_delta", delta: s } };
}

// Always begin from a clean session — resets the extension's module-scoped
// state so cases don't leak `forcedOff` / `priorLevel` into one another (and
// mirrors real startup: session_start always precedes the first agent run).
async function startRun(h: ReturnType<typeof makeHarness>) {
  await fire(h.pi, "session_start", {}, h.ctx);
  await fire(h.pi, "agent_start", {}, h.ctx);
  await fire(h.pi, "before_agent_start", { systemPromptOptions: {} }, h.ctx);
  await fire(h.pi, "turn_start", {}, h.ctx);
}

describe("thinking-budget recovery (issue #8)", () => {
  beforeEach(() => {
    process.env.LITTLE_CODER_THINKING_BUDGET = "10"; // tiny budget for short strings
  });
  afterEach(() => {
    delete process.env.LITTLE_CODER_THINKING_BUDGET;
  });

  it("registers NO turn_end handler (recovery must not run against a stale pi)", () => {
    const h = makeHarness();
    setupExtension(h.pi as any);
    expect(h.pi.handlers["turn_end"]).toBeUndefined();
  });

  it("on breach, runs the full recovery BEFORE abort and exactly once", async () => {
    const h = makeHarness();
    setupExtension(h.pi as any);
    await startRun(h);

    await fire(h.pi, "message_update", thinkingDelta("x".repeat(1000)), h.ctx);

    // setThinkingLevel("off") and sendUserMessage both happen before abort.
    expect(h.calls).toEqual(["set:off", "send", "notify", "abort"]);
    expect(h.level()).toBe("off");
    expect(h.followUps).toHaveLength(1);
    expect(h.followUps[0]).toMatch(/thinking budget exceeded/i);
    expect(h.notifies[0]).toMatch(/harness intervention:.*thought long enough/i);
  });

  it("does not double-abort across multiple bursts in the same turn", async () => {
    const h = makeHarness();
    setupExtension(h.pi as any);
    await startRun(h);
    await fire(h.pi, "message_update", thinkingDelta("x".repeat(1000)), h.ctx);
    await fire(h.pi, "message_update", thinkingDelta("y".repeat(1000)), h.ctx);
    await fire(h.pi, "message_update", thinkingDelta("z".repeat(1000)), h.ctx);

    expect(h.calls.filter((c) => c === "abort")).toHaveLength(1);
    expect(h.followUps).toHaveLength(1);
  });

  it("does not fire under budget", async () => {
    const h = makeHarness();
    setupExtension(h.pi as any);
    await startRun(h);
    await fire(h.pi, "message_update", thinkingDelta("ok"), h.ctx); // 2 chars < 10 tokens
    expect(h.calls).toEqual([]);
    expect(h.level()).toBe("high");
  });

  it("re-asserts thinking off on the restart turn even if pi re-enables it", async () => {
    const h = makeHarness();
    setupExtension(h.pi as any);
    await startRun(h);
    await fire(h.pi, "message_update", thinkingDelta("x".repeat(1000)), h.ctx); // breach → off

    // Simulate the post-abort session replacement re-resolving thinking to the
    // profile default. The bug was that this stuck; the fix re-asserts off.
    h.setLevelExternally("high");
    await fire(h.pi, "agent_start", {}, h.ctx); // restart run after the followUp
    await fire(h.pi, "before_agent_start", { systemPromptOptions: {} }, h.ctx);
    await fire(h.pi, "turn_start", {}, h.ctx);

    expect(h.level()).toBe("off");
  });

  it("restores the prior thinking level on the next genuine user input", async () => {
    const h = makeHarness("medium");
    setupExtension(h.pi as any);
    await startRun(h);
    await fire(h.pi, "message_update", thinkingDelta("x".repeat(1000)), h.ctx); // breach
    expect(h.level()).toBe("off");

    // A new user prompt ends the forced-off window and restores the level.
    await fire(h.pi, "input", { text: "next task", source: "interactive" }, h.ctx);
    expect(h.level()).toBe("medium");

    // And the force is cleared: a subsequent turn does NOT re-disable thinking.
    await fire(h.pi, "turn_start", {}, h.ctx);
    expect(h.level()).toBe("medium");
  });

  it("a fresh task (no prior breach) is never forced off", async () => {
    const h = makeHarness("low");
    setupExtension(h.pi as any);
    await fire(h.pi, "input", { text: "task", source: "interactive" }, h.ctx);
    await startRun(h);
    await fire(h.pi, "message_update", thinkingDelta("ok"), h.ctx);
    expect(h.level()).toBe("low");
    expect(h.calls).toEqual([]);
  });
});

// ── Issue #131: the nudge must not cancel the force it just installed ───────
// `pi.sendUserMessage(...)` runs through `prompt(..., { source: "extension" })`,
// so the extension's own follow-up arrives back at its `input` handler. The
// handler read that as "a genuinely new user prompt" and restored the level the
// breach had just disabled, so the restart turn thought at full level and
// breached again: one breach became a loop. Observed in a real session as 18
// `off` → `medium` level changes and 4 nudges in one run.
describe("extension-sent input does not end the forced-off window (issue #131)", () => {
  beforeEach(() => {
    process.env.LITTLE_CODER_THINKING_BUDGET = "10";
  });
  afterEach(() => {
    delete process.env.LITTLE_CODER_THINKING_BUDGET;
  });

  it("ignores an input event whose source is 'extension'", async () => {
    const h = makeHarness("medium");
    setupExtension(h.pi as any);
    await startRun(h);
    await fire(h.pi, "message_update", thinkingDelta("x".repeat(1000)), h.ctx);
    expect(h.level()).toBe("off");

    // pi replays the queued nudge as input. Restoring here is the bug.
    h.calls.length = 0;
    await fire(
      h.pi,
      "input",
      { text: "[thinking budget exceeded] Please commit to an implementation now.", source: "extension" },
      h.ctx,
    );
    expect(h.level()).toBe("off");
    expect(h.calls).toEqual([]);

    // And the force is still armed: the restart turn re-asserts "off".
    h.setLevelExternally("medium");
    await fire(h.pi, "turn_start", {}, h.ctx);
    expect(h.level()).toBe("off");
  });

  it("interactive and rpc input still end the forced-off window", async () => {
    for (const source of ["interactive", "rpc"] as const) {
      const h = makeHarness("medium");
      setupExtension(h.pi as any);
      await startRun(h);
      await fire(h.pi, "message_update", thinkingDelta("x".repeat(1000)), h.ctx);
      expect(h.level()).toBe("off");
      await fire(h.pi, "input", { text: "next task", source }, h.ctx);
      expect(h.level(), source).toBe("medium");
      await fire(h.pi, "turn_start", {}, h.ctx);
      expect(h.level(), source).toBe("medium");
    }
  });
});

// ── Issues #130 / #137: which budget is in force ────────────────────────────
// Before this change the `||` chain tested the profile first, and every shipped
// profile sets `thinking_budget: 4096`, so `LITTLE_CODER_THINKING_BUDGET` could
// never apply and `DEFAULT_BUDGET` was unreachable: the cap could only be
// raised by editing a file inside the npm package.
describe("resolveThinkingBudget precedence (issues #130/#137)", () => {
  it("outside benchmark mode, env beats a profile budget", () => {
    expect(resolveThinkingBudget(4096, 16000, false)).toEqual({
      budget: 16000,
      source: "env",
      envOverrodeProfile: true,
    });
  });
  it("in benchmark mode the profile budget still wins", () => {
    expect(resolveThinkingBudget(2000, 16000, true)).toEqual({
      budget: 2000,
      source: "profile",
      envOverrodeProfile: false,
    });
  });
  it("benchmark mode falls through to env only when the profile has none", () => {
    expect(resolveThinkingBudget(Number(undefined), 16000, true)).toMatchObject({
      budget: 16000,
      source: "env",
    });
  });
  it("a non-numeric or non-positive env value is ignored", () => {
    for (const raw of [Number("abc"), Number("0"), Number("-5")]) {
      expect(resolveThinkingBudget(4096, raw, false)).toMatchObject({
        budget: 4096,
        source: "profile",
      });
    }
  });
  it("with neither set, DEFAULT_BUDGET 4096 applies", () => {
    expect(resolveThinkingBudget(Number(undefined), Number(undefined), false)).toEqual({
      budget: 4096,
      source: "default",
      envOverrodeProfile: false,
    });
  });
  it("an env value equal to the profile value is not reported as an override", () => {
    expect(resolveThinkingBudget(4096, 4096, false).envOverrodeProfile).toBe(false);
  });
});

describe("thinking-budget resolution end to end", () => {
  afterEach(() => {
    delete process.env.LITTLE_CODER_THINKING_BUDGET;
    delete process.env.LITTLE_CODER_BENCHMARK;
  });

  it("an env budget raises the shipped profile budget outside benchmark mode", async () => {
    process.env.LITTLE_CODER_THINKING_BUDGET = "100";
    const h = makeHarness();
    setupExtension(h.pi as any);
    await fire(h.pi, "session_start", {}, h.ctx);
    await fire(h.pi, "agent_start", {}, h.ctx);
    // Profile budget 10 tokens (~35 chars): under the old order the profile won
    // and 200 chars (≈58 tokens) aborted the turn; now the env raises it.
    await fire(
      h.pi,
      "before_agent_start",
      { systemPromptOptions: { littleCoder: { thinkingBudget: 10 } } },
      h.ctx,
    );
    await fire(h.pi, "turn_start", {}, h.ctx);
    await fire(h.pi, "message_update", thinkingDelta("x".repeat(200)), h.ctx);
    // No breach: the only call is the config notice's notify.
    expect(h.calls.filter((c) => c !== "notify")).toEqual([]);
    expect(h.followUps).toHaveLength(0);
    expect(h.level()).toBe("high");
    // One notice, naming the number and its source.
    expect(h.notifies).toHaveLength(1);
    expect(h.notifies[0]).toMatch(/thinking budget: 100 tokens.*LITTLE_CODER_THINKING_BUDGET/);
  });

  it("the profile budget still wins inside benchmark mode", async () => {
    process.env.LITTLE_CODER_THINKING_BUDGET = "100";
    process.env.LITTLE_CODER_BENCHMARK = "terminal_bench";
    const h = makeHarness();
    setupExtension(h.pi as any);
    await fire(h.pi, "session_start", {}, h.ctx);
    await fire(h.pi, "agent_start", {}, h.ctx);
    await fire(
      h.pi,
      "before_agent_start",
      { systemPromptOptions: { littleCoder: { thinkingBudget: 10 } } },
      h.ctx,
    );
    await fire(h.pi, "turn_start", {}, h.ctx);
    // 40 chars ≈ 12 tokens > the 10-token profile budget → breach as tuned.
    await fire(h.pi, "message_update", thinkingDelta("x".repeat(40)), h.ctx);
    expect(h.calls).toEqual(["set:off", "send", "notify", "abort"]);
    expect(h.notifies.some((m) => /harness intervention/.test(m))).toBe(true);
    // No config notice: the env value never applied, so there is nothing to report.
    expect(h.notifies.some((m) => /LITTLE_CODER_THINKING_BUDGET/.test(m))).toBe(false);
  });

  it("no notice when env and profile agree, and the notice is once per session", async () => {
    process.env.LITTLE_CODER_THINKING_BUDGET = "10";
    const h = makeHarness();
    setupExtension(h.pi as any);
    await fire(h.pi, "session_start", {}, h.ctx);
    for (let i = 0; i < 3; i++) {
      await fire(h.pi, "agent_start", {}, h.ctx);
      await fire(
        h.pi,
        "before_agent_start",
        { systemPromptOptions: { littleCoder: { thinkingBudget: 10 } } },
        h.ctx,
      );
    }
    expect(h.notifies).toHaveLength(0);

    await fire(
      h.pi,
      "before_agent_start",
      { systemPromptOptions: { littleCoder: { thinkingBudget: 4096 } } },
      h.ctx,
    );
    await fire(h.pi, "agent_start", {}, h.ctx);
    await fire(
      h.pi,
      "before_agent_start",
      { systemPromptOptions: { littleCoder: { thinkingBudget: 4096 } } },
      h.ctx,
    );
    expect(h.notifies.filter((m) => /thinking budget: 10 tokens/.test(m))).toHaveLength(1);
  });
});
