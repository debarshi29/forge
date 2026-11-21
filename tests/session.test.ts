import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { costOf, formatCost } from "../src/agent/cost.js";
import { Agent } from "../src/agent/loop.js";
import { loadMemory } from "../src/agent/memory.js";
import { findSession, listSessions, loadSession, resumeInto, Session } from "../src/agent/session.js";
import { buildSystemPrompt } from "../src/agent/systemPrompt.js";
import { Permissions } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import { defaultTools } from "../src/tools/registry.js";
import { tempDir } from "./helpers.js";

function makeAgent(root: string, turns: FakeTurn[], model = "claude-opus-5-5") {
  const provider = new FakeProvider(turns, "anthropic");
  const agent = new Agent({ provider, model, system: "t", tools: defaultTools(), permissions: new Permissions("bypass"), root });
  return { agent, provider };
}

async function drain(gen: AsyncGenerator<unknown>) {
  for await (const _ of gen) {
    /* consume */
  }
}

describe("sessions", () => {
  it("persists a conversation and resumes it with identical history", async () => {
    const home = await tempDir();
    const root = await tempDir();
    const env = { FORGE_HOME: home };

    const { agent } = makeAgent(root, [
      { toolCalls: [{ name: "ls", input: {} }], usage: { inputTokens: 1000, outputTokens: 100 } },
      { text: "All done.", usage: { inputTokens: 2000, outputTokens: 50, cacheReadTokens: 1500 } },
    ]);
    agent.setRecorder(new Session(root, agent.model, { env }));
    await drain(agent.send("list files"));

    const [info] = listSessions(root, env);
    expect(info).toMatchObject({ title: "list files", messages: 4 });

    const loaded = loadSession(info!.file);
    expect(loaded.messages).toEqual(agent.messages);
    expect(loaded.usage).toMatchObject({ inputTokens: 3000, outputTokens: 150, cacheReadTokens: 1500 });
    expect(loaded.costUSD).toBeCloseTo(agent.costUSD, 10);
    expect(loaded.lastInputTokens).toBe(2000);

    // Continue in a new agent; the next request carries the old history.
    const next = makeAgent(root, [{ text: "Hi again." }]);
    resumeInto(next.agent, root, info!, env);
    await drain(next.agent.send("and now?"));
    expect(next.provider.requests[0]!.messages).toHaveLength(5);
    expect(loadSession(info!.file).messages).toHaveLength(6);
  });

  it("repairs a crash mid-tool and persists the repair", async () => {
    const home = await tempDir();
    const root = await tempDir();
    const env = { FORGE_HOME: home };
    const session = new Session(root, "fake", { env });
    session.message({ role: "user", content: [{ type: "text", text: "go" }] });
    session.message({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "sleep 99" } }] });
    await fs.appendFile(session.file, '{"t":"msg","m":{"role":"us'); // torn line

    const loaded = loadSession(session.file);
    expect(loaded.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", toolUseId: "t1", isError: true }] });

    const { agent, provider } = makeAgent(root, [{ text: "ok" }]);
    resumeInto(agent, root, { id: session.id, file: session.file }, env);
    await drain(agent.send("continue"));
    const sent = provider.requests[0]!.messages;
    expect(sent.at(-1)!.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
    // Reloading again gives the same valid history.
    expect(loadSession(session.file).messages.slice(0, 3)).toEqual(sent);
  });

  it("finds sessions by unique id prefix", async () => {
    const home = await tempDir();
    const root = await tempDir();
    const env = { FORGE_HOME: home };
    const s = new Session(root, "fake", { env, id: "abc-123" });
    s.message({ role: "user", content: [{ type: "text", text: "x" }] });
    expect(findSession(root, "abc", env)?.id).toBe("abc-123");
    expect(findSession(root, "zzz", env)).toBeUndefined();
  });

  it("writes nothing for sessions that never start", async () => {
    const home = await tempDir();
    const root = await tempDir();
    new Session(root, "fake", { env: { FORGE_HOME: home } });
    expect(listSessions(root, { FORGE_HOME: home })).toEqual([]);
  });
});

describe("cost", () => {
  it("prices Opus 5.5 with cache reads and writes", () => {
    // 1M fresh in ($4) + 1M out ($20) + 1M cache read ($0.20) + 1M cache write ($5)
    const usd = costOf("anthropic:claude-opus-5-5", {
      inputTokens: 3_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(29.2, 6);
    expect(costOf("ollama:qwen3", { inputTokens: 5, outputTokens: 5 })).toBeUndefined();
    expect(formatCost(0.004)).toBe("$0.0040");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});

describe("memory files", () => {
  it("loads user then project files from repo root down to cwd", async () => {
    const home = await tempDir();
    const repo = await tempDir();
    await fs.mkdir(path.join(repo, ".git"));
    await fs.mkdir(path.join(repo, "pkg"));
    await fs.writeFile(path.join(home, "AGENTS.md"), "user rule");
    await fs.writeFile(path.join(repo, "AGENTS.md"), "repo rule");
    await fs.writeFile(path.join(repo, "pkg", "FORGE.md"), "pkg rule");
    await fs.writeFile(path.join(repo, "pkg", "AGENTS.md"), "  ");

    const mem = loadMemory(path.join(repo, "pkg"), { FORGE_HOME: home });
    expect(mem.map((m) => [m.scope, m.content])).toEqual([
      ["user", "user rule"],
      ["project", "repo rule"],
      ["project", "pkg rule"],
    ]);

    const prompt = buildSystemPrompt({ root: repo, cwd: repo, model: "m", memory: mem });
    expect(prompt).toContain("repo rule");
    expect(prompt.indexOf("repo rule")).toBeLessThan(prompt.indexOf("pkg rule"));
  });
});
