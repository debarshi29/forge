import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGoalArgs, runGoal, type CheckRunner } from "../src/agent/goal.js";
import { Agent, type AgentEvent } from "../src/agent/loop.js";
import { formatInterval, parseInterval } from "../src/commands/index.js";
import { Permissions } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import { toOpenAIMessages } from "../src/providers/openai.js";
import { defaultTools } from "../src/tools/registry.js";
import { tempDir } from "./helpers.js";

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function setup(turns: FakeTurn[], extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const root = await tempDir();
  const provider = new FakeProvider(turns);
  const agent = new Agent({ provider, model: "m", system: "s", tools: defaultTools(), permissions: new Permissions("bypass", undefined, { root }), root, ...extra });
  return { root, provider, agent };
}

const goals = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "goal" ? [`${e.phase}: ${e.text}`] : []));

describe("goal arguments", () => {
  it("parses the objective, --check and --max-rounds", () => {
    expect(parseGoalArgs('make the tests pass --check "npm test -- --run" --max-rounds 3')).toEqual({ objective: "make the tests pass", check: "npm test -- --run", maxRounds: 3 });
    expect(parseGoalArgs("--check 'pytest -q' fix the parser")).toEqual({ objective: "fix the parser", check: "pytest -q" });
    expect(parseGoalArgs("add a README")).toEqual({ objective: "add a README" });
    expect(parseGoalArgs("  ")).toBeUndefined();
  });

  it("parses loop intervals", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("10m")).toBe(600_000);
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(parseInterval("5s")).toBeUndefined();
    expect(parseInterval("soon")).toBeUndefined();
    expect(formatInterval(600_000)).toBe("10m");
    expect(formatInterval(45_000)).toBe("45s");
  });
});

describe("goals", () => {
  it("keeps going until the check passes, showing the model each failure", async () => {
    const { provider, agent, root } = await setup([{ text: "first try" }, { text: "second try" }]);
    const results = [
      { ok: false, code: 1, output: "1 failing" },
      { ok: false, code: 1, output: "FAIL add.test.js: expected 3, got -1" },
      { ok: true, code: 0, output: "all passed" },
    ];
    const check: CheckRunner = async () => results.shift()!;
    const events = await collect(runGoal(agent, root, { objective: "make the tests pass", check: "npm test" }, new AbortController().signal, check));
    expect(goals(events)).toEqual([
      "start: Goal: make the tests pass · done when `npm test` passes · up to 8 rounds",
      "check: `npm test` still fails (exit 1).",
      "round: Round 2/8",
      "done: Goal met: `npm test` passes (after 2 rounds).",
    ]);
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain("expected 3, got -1");
  });

  it("does nothing when the check already passes", async () => {
    const { provider, agent, root } = await setup([]);
    const events = await collect(runGoal(agent, root, { objective: "x", check: "true" }, new AbortController().signal, async () => ({ ok: true, code: 0, output: "" })));
    expect(goals(events).at(-1)).toMatch(/already passes/);
    expect(provider.requests).toHaveLength(0);
  });

  it("without a check, stops when the model says GOAL COMPLETE, or after the rounds run out", async () => {
    const done = await setup([{ text: "working" }, { text: "Verified it works.\nGOAL COMPLETE" }]);
    const ev = await collect(runGoal(done.agent, done.root, { objective: "x" }, new AbortController().signal));
    expect(goals(ev).at(-1)).toBe("done: Goal met (after 2 rounds).");

    const stuck = await setup([{ text: "a" }, { text: "b" }]);
    const ev2 = await collect(runGoal(stuck.agent, stuck.root, { objective: "x", maxRounds: 2 }, new AbortController().signal));
    expect(goals(ev2).at(-1)).toBe("stopped: Stopped after 2 rounds without meeting the goal.");
  });

  it("runs a real check command", async () => {
    const { agent, root } = await setup([{ toolCalls: [{ name: "write", input: { path: "done.txt", content: "ok" } }] }, { text: "wrote it" }]);
    const events = await collect(runGoal(agent, root, { objective: "create done.txt", check: "test -f done.txt" }, new AbortController().signal));
    expect(goals(events).at(-1)).toBe("done: Goal met: `test -f done.txt` passes (after 1 round).");
  });
});

describe("empty replies", () => {
  it("are sent back to OpenAI-compatible servers as empty text, not null", () => {
    expect(toOpenAIMessages([{ role: "assistant", content: [] }])).toEqual([{ role: "assistant", content: "" }]);
    expect(toOpenAIMessages([{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "ls", input: {} }] }])[0]).toMatchObject({ content: null });
  });
});

describe("budgets", () => {
  it("stops a prompt after its request limit", async () => {
    const { agent } = await setup(
      [{ toolCalls: [{ name: "ls", input: {} }] }, { toolCalls: [{ name: "ls", input: {} }] }, { text: "never reached" }],
      { budget: { requestsPerPrompt: 2 } },
    );
    const events = await collect(agent.send("loop"));
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "budget", detail: expect.stringContaining("limit of 2 model requests") });
  });

  it("stops when the session's tokens run out, and a goal stops with it", async () => {
    const { agent, root } = await setup([{ text: "one", usage: { inputTokens: 600, outputTokens: 500 } }, { text: "two" }], { budget: { tokens: 1000 } });
    const events = await collect(runGoal(agent, root, { objective: "x" }, new AbortController().signal));
    expect(goals(events).at(-1)).toMatch(/^stopped: Goal stopped: Stopped: the session used 1100 tokens/);
    agent.setBudget(undefined);
    expect(agent.budget).toBeUndefined();
  });
});

describe("background commands", () => {
  it("runs bash in the background and delivers its output", async () => {
    const { agent, provider } = await setup([
      { toolCalls: [{ name: "bash", input: { command: "sleep 0.2; echo built ok", run_in_background: true, description: "build" } }] },
      { text: "started the build" },
      { text: "the build passed" },
    ]);
    const done: string[] = [];
    agent.onBackgroundDone((t) => done.push(`${t.id} ${t.kind} ${t.status}`));
    const events = await collect(agent.send("build it"));
    const started = events.find((e) => e.type === "tool_end");
    expect(started).toMatchObject({ result: { content: expect.stringMatching(/^Started bash-1 in the background/) } });
    await agent.waitForBackground();
    expect(done).toEqual(["bash-1 bash done"]);
    await collect(agent.send([]));
    const note = JSON.stringify(provider.requests[2]!.messages.at(-1));
    expect(note).toContain("Background command bash-1 (build) finished");
    expect(note).toContain("built ok");
  });

  it("keeps the shell's directory for foreground commands only", async () => {
    const { agent, root } = await setup([
      { toolCalls: [{ name: "bash", input: { command: "mkdir -p sub && cd sub", run_in_background: true } }] },
      { toolCalls: [{ name: "bash", input: { command: "pwd" } }] },
      { text: "x" },
    ]);
    await fs.mkdir(path.join(root, "sub"));
    await agent.waitForBackground();
    const events = await collect(agent.send("go"));
    const pwd = events.filter((e) => e.type === "tool_end").at(-1);
    expect(JSON.stringify(pwd)).not.toMatch(/sub\\n|\/sub"/);
  });
});
