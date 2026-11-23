import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../src/agent/loop.js";
import { BUILTIN_AGENTS, loadAgentTypes, parseAgentFile, toolsFor, type AgentType } from "../src/agent/subagents.js";
import { Permissions, type AskFn } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import { defaultTools } from "../src/tools/registry.js";
import { makeTaskTool } from "../src/tools/task.js";
import { tempDir } from "./helpers.js";

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function setup(turns: FakeTurn[], opts: { types?: AgentType[]; children?: Record<string, FakeProvider>; ask?: AskFn } = {}) {
  const root = await tempDir();
  const provider = new FakeProvider(turns);
  const types = opts.types ?? BUILTIN_AGENTS;
  const agent = new Agent({
    provider,
    model: "main",
    system: "parent system",
    tools: [...defaultTools(), makeTaskTool(types)],
    permissions: new Permissions(opts.ask ? "default" : "bypass", opts.ask, { root }),
    root,
    agentTypes: types,
    resolveModel: async (spec) => ({ provider: opts.children![spec]!, model: spec }),
  });
  return { root, provider, agent };
}

const resultOf = (p: FakeProvider, request: number, i = 0) =>
  p.requests[request]!.messages.at(-1)!.content.flatMap((b) => (b.type === "tool_result" ? [b] : []))[i];

describe("agent types", () => {
  it("parses agent files", () => {
    const t = parseAgentFile("---\nname: reviewer\ndescription: Reviews diffs\ntools: read, grep, glob\nmodel: fast\n---\nReview carefully.\n", "reviewer.md");
    expect(t).toEqual({ name: "reviewer", description: "Reviews diffs", tools: ["read", "grep", "glob"], model: "fast", prompt: "Review carefully.", source: "reviewer.md" });
    expect(parseAgentFile("---\ndescription: x\ntools: readonly\n---\nbody", "/a/b/docs.md")).toMatchObject({ name: "docs", tools: "readonly" });
    expect(() => parseAgentFile("no frontmatter", "x.md")).toThrow(/frontmatter/);
    expect(() => parseAgentFile("---\nname: y\n---\n", "y.md")).toThrow(/description/);
  });

  it("loads user and project agents over the built-ins", async () => {
    const home = await tempDir();
    const root = await tempDir();
    await fs.mkdir(path.join(home, "agents"));
    await fs.mkdir(path.join(root, ".forge", "agents"), { recursive: true });
    await fs.writeFile(path.join(home, "agents", "a.md"), "---\nname: tester\ndescription: user version\n---\nu");
    await fs.writeFile(path.join(root, ".forge", "agents", "b.md"), "---\nname: tester\ndescription: project version\n---\np");
    await fs.writeFile(path.join(root, ".forge", "agents", "bad.md"), "oops");
    const { types, errors } = loadAgentTypes(root, { FORGE_HOME: home });
    expect(types.map((t) => t.name)).toEqual(["explore", "plan", "general", "tester"]);
    expect(types.find((t) => t.name === "tester")?.description).toBe("project version");
    expect(errors).toHaveLength(1);
  });

  it("gives each type the right tools, never task", () => {
    const all = [...defaultTools(), makeTaskTool(BUILTIN_AGENTS)];
    const names = (t: AgentType) => toolsFor(t, all).map((x) => x.name);
    expect(names(BUILTIN_AGENTS[0]!)).toEqual(["read", "glob", "grep", "ls", "repo_map"]);
    expect(names(BUILTIN_AGENTS[2]!)).not.toContain("task");
    expect(names(BUILTIN_AGENTS[2]!)).toContain("write");
    expect(names({ ...BUILTIN_AGENTS[2]!, tools: ["read", "bash", "nope"] })).toEqual(["read", "bash"]);
  });
});

describe("task tool", () => {
  it("runs a subagent with a fresh context and returns only its report", async () => {
    const { provider, agent } = await setup([
      { text: "Let me delegate.", toolCalls: [{ name: "task", input: { description: "find the config", prompt: "Where is the port set?", subagent_type: "explore" } }] },
      // The subagent: one search, then its report.
      { toolCalls: [{ name: "ls", input: {} }] },
      { text: "The port is set in config.js:3." },
      { text: "It's in config.js." },
    ]);
    const events = await collect(agent.send("where is the port?"));
    const child = provider.requests[1]!;
    expect(child.system).toContain("You are a subagent (explore)");
    expect(child.messages).toHaveLength(1);
    expect(JSON.stringify(child.messages)).not.toContain("where is the port?");
    expect(child.tools.map((t) => t.name)).not.toContain("write");
    expect(events).toContainEqual({ type: "tool_progress", id: expect.any(String), text: expect.stringMatching(/^ls/) });
    const r = resultOf(provider, 3)!;
    expect(r.content).toMatch(/^The port is set in config.js:3\.\n\n\[explore agent: 1 tool call, \d+ tokens\]$/);
    // Parent usage includes the child's two requests.
    expect(agent.usage.outputTokens).toBe(5 * 4);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "It's in config.js." });
  });

  it("runs several subagents in parallel", async () => {
    const { provider, agent } = await setup([
      {
        toolCalls: [
          { name: "task", input: { description: "a", prompt: "look at a", subagent_type: "explore" } },
          { name: "task", input: { description: "b", prompt: "look at b", subagent_type: "explore" } },
        ],
      },
      { text: "report one", delayMs: 30 },
      { text: "report two", delayMs: 30 },
      { text: "both done" },
    ]);
    const started = Date.now();
    await collect(agent.send("check a and b"));
    expect(Date.now() - started).toBeLessThan(55);
    const results = [resultOf(provider, 3, 0)!.content, resultOf(provider, 3, 1)!.content].join("\n");
    expect(results).toContain("report one");
    expect(results).toContain("report two");
  });

  it("rejects unknown types", async () => {
    const { provider, agent } = await setup([{ toolCalls: [{ name: "task", input: { description: "x", prompt: "y", subagent_type: "wizard" } }] }, { text: "ok" }]);
    await collect(agent.send("go"));
    expect(resultOf(provider, 1)).toMatchObject({ isError: true, content: expect.stringContaining('Unknown subagent_type "wizard"') });
  });

  it("runs background agents and delivers their reports", async () => {
    const helper = new FakeProvider([{ text: "background report", delayMs: 20 }], "helper");
    const types: AgentType[] = [...BUILTIN_AGENTS, { name: "bg", description: "x", tools: "readonly", model: "helper:small", prompt: "p", source: "test" }];
    const { provider, agent } = await setup(
      [{ toolCalls: [{ name: "task", input: { description: "long job", prompt: "do it", subagent_type: "bg", run_in_background: true } }] }, { text: "started it" }, { text: "used the report" }],
      { types, children: { "helper:small": helper } },
    );
    const finished: string[] = [];
    agent.onBackgroundDone((t) => finished.push(`${t.id}:${t.status}`));
    await collect(agent.send("start the job"));
    expect(resultOf(provider, 1)!.content).toMatch(/^Started background agent agent-1/);
    expect(agent.backgroundTasks[0]).toMatchObject({ id: "agent-1", status: "running" });
    await agent.waitForBackground();
    expect(finished).toEqual(["agent-1:done"]);
    expect(agent.pendingNotes).toBe(1);
    const events = await collect(agent.send([]));
    expect(events.at(-1)).toMatchObject({ type: "done", text: "used the report" });
    expect(JSON.stringify(provider.requests[2]!.messages.at(-1))).toContain("background report");
    expect(agent.pendingNotes).toBe(0);
  });

  it("stops a background agent", async () => {
    const helper = new FakeProvider([{ text: "never", delayMs: 5000 }], "helper");
    const types: AgentType[] = [...BUILTIN_AGENTS, { name: "bg", description: "x", tools: "readonly", model: "helper:small", prompt: "p", source: "test" }];
    const { agent } = await setup(
      [{ toolCalls: [{ name: "task", input: { description: "slow", prompt: "x", subagent_type: "bg", run_in_background: true } }] }, { text: "ok" }],
      { types, children: { "helper:small": helper } },
    );
    await collect(agent.send("go"));
    expect(agent.stopBackground("agent-1")).toBe(true);
    await agent.waitForBackground();
    expect(agent.backgroundTasks[0]!.status).toBe("stopped");
    expect(agent.stopBackground("agent-1")).toBe(false);
  });

  it("asks the user one question at a time", async () => {
    let open = 0;
    let maxOpen = 0;
    const ask: AskFn = async () => {
      maxOpen = Math.max(maxOpen, ++open);
      await new Promise((r) => setTimeout(r, 10));
      open--;
      return { kind: "yes" };
    };
    const { provider, agent } = await setup(
      [
        {
          toolCalls: [
            { name: "task", input: { description: "a", prompt: "write a", subagent_type: "general" } },
            { name: "task", input: { description: "b", prompt: "write b", subagent_type: "general" } },
          ],
        },
        { toolCalls: [{ name: "write", input: { path: "a.txt", content: "a" } }] },
        { toolCalls: [{ name: "write", input: { path: "b.txt", content: "b" } }] },
        { text: "wrote one" },
        { text: "wrote other" },
        { text: "done" },
      ],
      { ask },
    );
    await collect(agent.send("write both"));
    expect(maxOpen).toBe(1);
    expect(provider.requests).toHaveLength(6);
  });
});
