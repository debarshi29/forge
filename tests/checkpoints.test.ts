import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { branchTree, createWorktree, forkSession } from "../src/agent/fork.js";
import { Agent, type AgentEvent } from "../src/agent/loop.js";
import { listSessions, loadSession, Session } from "../src/agent/session.js";
import { BUILTIN_AGENTS } from "../src/agent/subagents.js";
import { addProjectAllowRule } from "../src/config/index.js";
import { Permissions, suggestRule, type AskFn } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import { defaultTools } from "../src/tools/registry.js";
import { makeTaskTool } from "../src/tools/task.js";
import { tempDir } from "./helpers.js";

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function setup(turns: FakeTurn[], extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const root = await tempDir();
  const provider = new FakeProvider(turns);
  const agent = new Agent({
    provider,
    model: "m",
    system: "s",
    tools: [...defaultTools(), makeTaskTool(BUILTIN_AGENTS)],
    permissions: new Permissions("bypass", undefined, { root }),
    root,
    agentTypes: BUILTIN_AGENTS,
    ...extra,
  });
  return { root, provider, agent };
}

const read = (root: string, f: string) => fs.readFile(path.join(root, f), "utf8").catch(() => undefined);

describe("checkpoints and rewind", () => {
  it("restores files and the conversation to before a prompt", async () => {
    const { root, agent } = await setup([
      { toolCalls: [{ name: "read", input: { path: "b.txt" } }] },
      { toolCalls: [{ name: "write", input: { path: "a.txt", content: "new file" } }, { name: "edit", input: { path: "b.txt", old_string: "one", new_string: "two" } }] },
      { text: "changed both" },
      { toolCalls: [{ name: "edit", input: { path: "b.txt", old_string: "two", new_string: "three" } }] },
      { text: "changed b again" },
    ]);
    await fs.writeFile(path.join(root, "b.txt"), "one");
    await collect(agent.send("first change"));
    await collect(agent.send("second change"));
    expect(await read(root, "b.txt")).toBe("three");
    expect(agent.checkpoints.list.map((c) => [c.n, c.prompt, c.files.size])).toEqual([
      [1, "first change", 2],
      [2, "second change", 1],
    ]);

    // Code only, back to before prompt 2: the conversation stays.
    const before = agent.messages.length;
    const r2 = await agent.rewind(2, "code");
    expect(r2.code?.restored).toHaveLength(1);
    expect(await read(root, "b.txt")).toBe("two");
    expect(agent.messages).toHaveLength(before);

    // Everything, back to before prompt 1.
    const r1 = await agent.rewind(1, "both");
    expect(r1.prompt).toBe("first change");
    expect(r1.code?.deleted.map((f) => path.basename(f))).toEqual(["a.txt"]);
    expect(await read(root, "a.txt")).toBeUndefined();
    expect(await read(root, "b.txt")).toBe("one");
    expect(agent.messages).toHaveLength(0);
    expect(agent.checkpoints.list).toHaveLength(0);
  });

  it("won't overwrite files changed outside Forge unless forced", async () => {
    const { root, agent } = await setup([{ toolCalls: [{ name: "write", input: { path: "x.txt", content: "forge" } }] }, { text: "ok" }]);
    await collect(agent.send("write x"));
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(root, "x.txt"), "my own edit");
    const blocked = await agent.rewind(1, "code");
    expect(blocked.needsForce?.map((f) => path.basename(f))).toEqual(["x.txt"]);
    expect(await read(root, "x.txt")).toBe("my own edit");
    await agent.rewind(1, "code", { force: true });
    expect(await read(root, "x.txt")).toBeUndefined();
  });

  it("rewinds only the conversation with chat, and covers subagents' edits", async () => {
    const { root, agent } = await setup([
      { toolCalls: [{ name: "task", input: { description: "write", prompt: "write y.txt", subagent_type: "general" } }] },
      { toolCalls: [{ name: "write", input: { path: "y.txt", content: "from the subagent" } }] },
      { text: "subagent done" },
      { text: "all done" },
    ]);
    await collect(agent.send("delegate it"));
    expect(agent.checkpoints.list).toHaveLength(1);
    expect(agent.checkpoints.list[0]!.files.size).toBe(1);
    await agent.rewind(1, "chat");
    expect(await read(root, "y.txt")).toBe("from the subagent");
    expect(agent.messages).toHaveLength(0);
  });

  it("records the rewind in the session so resuming sees the shorter history", async () => {
    const home = await tempDir();
    const env = { FORGE_HOME: home };
    const { root, agent } = await setup([{ text: "one" }, { text: "two" }]);
    const session = new Session(root, "fake:m", { env });
    agent.setRecorder(session);
    await collect(agent.send("first"));
    await collect(agent.send("second"));
    await agent.rewind(2, "chat");
    expect(loadSession(session.file).messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("forks and branches", () => {
  it("copies a conversation into a child session and shows the tree", async () => {
    const home = await tempDir();
    const env = { FORGE_HOME: home };
    const root = await tempDir();
    const parent = new Session(root, "fake:m", { env });
    parent.message({ role: "user", content: [{ type: "text", text: "build a parser" }] });
    parent.message({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    const messages = loadSession(parent.file).messages;
    const child = forkSession(messages, { root, model: "fake:m", parent: parent.id, env });
    const loaded = loadSession(child.file);
    expect(loaded.messages).toEqual(messages);
    expect(loaded.info.parent).toBe(parent.id);
    expect(listSessions(root, env)).toHaveLength(2);
    const tree = branchTree(root, child.id, env);
    expect(tree.split("\n")).toEqual([`  ${parent.id}  build a parser  (2 msgs)`, `  ● ${child.id}  build a parser  (2 msgs)`]);
  });

  it("creates a git worktree on a new branch", async () => {
    const repo = await tempDir();
    await execa("git", ["init", "-q"], { cwd: repo });
    await fs.writeFile(path.join(repo, "f.txt"), "x");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    const wt = await createWorktree(repo, "fork-test");
    expect(wt.branch).toBe("forge/fork-test");
    expect(await read(wt.path, "f.txt")).toBe("x");
    const branches = await execa("git", ["branch", "--list", "forge/*"], { cwd: repo });
    expect(branches.stdout).toContain("forge/fork-test");
    await expect(createWorktree(await tempDir(), "x")).rejects.toThrow(/isn't a git repository/);
  });
});

describe("saving always-allow rules", () => {
  it("suggests a rule per call", () => {
    expect(suggestRule("bash", { command: "npm test -- --run" }, "/p")).toBe("bash(npm test:*)");
    expect(suggestRule("bash", { command: "npm run build" }, "/p")).toBe("bash(npm run build:*)");
    expect(suggestRule("bash", { command: "ls -la" }, "/p")).toBe("bash(ls:*)");
    expect(suggestRule("bash", { command: "npm test && rm -rf x" }, "/p")).toBeUndefined();
    expect(suggestRule("bash", { command: "echo $(whoami)" }, "/p")).toBeUndefined();
    expect(suggestRule("edit", { path: "src/a.ts" }, path.resolve("/p"))).toBe("edit(src/a.ts)");
  });

  it("saves the rule and stops asking for matching calls", async () => {
    const root = await tempDir();
    const saved: string[] = [];
    const asked: string[] = [];
    const ask: AskFn = async (req) => {
      asked.push(`${req.summary} [${req.saveRule}]`);
      return { kind: "save" };
    };
    const provider = new FakeProvider([
      { toolCalls: [{ name: "bash", input: { command: "node --version" } }] },
      { toolCalls: [{ name: "bash", input: { command: "node -e 1" } }] },
      { toolCalls: [{ name: "bash", input: { command: "git --version" } }] },
      { text: "done" },
    ]);
    const agent = new Agent({ provider, model: "m", system: "s", tools: defaultTools(), permissions: new Permissions("default", ask, { root, saveRule: (r) => saved.push(r) }), root });
    await collect(agent.send("check versions"));
    // The saved bash(node:*) covers "node -e 1"; git still asks.
    expect(asked).toEqual(["node --version [bash(node:*)]", "git --version [bash(git:*)]"]);
    expect(saved).toEqual(["bash(node:*)", "bash(git:*)"]);
  });

  it("writes rules to the project's settings once", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, ".forge"));
    await fs.writeFile(path.join(root, ".forge", "settings.json"), JSON.stringify({ theme: "x", permissions: { deny: ["read(.env)"] } }));
    addProjectAllowRule(root, "bash(npm test:*)");
    addProjectAllowRule(root, "bash(npm test:*)");
    expect(JSON.parse(await fs.readFile(path.join(root, ".forge", "settings.json"), "utf8"))).toEqual({
      theme: "x",
      permissions: { deny: ["read(.env)"], allow: ["bash(npm test:*)"] },
    });
  });
});
