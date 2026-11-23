import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseCut, COMPACT_MARKER, estimateMessages, renderTranscript } from "../src/agent/compact.js";
import { contextBreakdown, formatContext } from "../src/agent/context.js";
import { Agent, type AgentEvent } from "../src/agent/loop.js";
import { loadSession, Session } from "../src/agent/session.js";
import { Permissions } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import type { Message } from "../src/providers/types.js";
import { defaultTools } from "../src/tools/registry.js";
import { tempDir } from "./helpers.js";

async function collect(gen: AsyncGenerator<AgentEvent, unknown>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function setup(turns: FakeTurn[], opts: { window?: number; env?: NodeJS.ProcessEnv; autoCompact?: boolean } = {}) {
  const root = await tempDir();
  const provider = new FakeProvider(turns, "fake", opts.window ?? 100_000);
  const agent = new Agent({
    provider,
    model: "fake",
    system: "test system prompt",
    tools: defaultTools(),
    permissions: new Permissions("bypass"),
    root,
    ...(opts.autoCompact !== undefined ? { autoCompact: opts.autoCompact } : {}),
  });
  return { root, provider, agent };
}

const text = (m: Message) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

describe("choosing what to keep", () => {
  const big = "x".repeat(4000); // ~1000 tokens
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "build it" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: big }] },
    { role: "assistant", content: [{ type: "tool_use", id: "b", name: "read", input: { path: "b.ts" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "b", content: big }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "now test it" }] },
  ];

  it("keeps the longest recent suffix that fits, starting at an assistant turn", () => {
    expect(chooseCut(history, 1200)).toBe(3);
    expect(chooseCut(history, 50)).toBe(5);
    // Everything fits: still summarize the first prompt only (manual /compact).
    expect(chooseCut(history, 1_000_000)).toBe(1);
    expect(chooseCut([history[0]!], 100)).toBeUndefined();
  });

  it("never splits a tool call from its result", () => {
    for (const budget of [10, 500, 1100, 2200, 5000]) {
      const kept = history.slice(chooseCut(history, budget)!);
      const ids = new Set(kept.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []))));
      for (const m of kept) for (const b of m.content) if (b.type === "tool_result") expect(ids.has(b.toolUseId)).toBe(true);
      expect(kept[0]!.role).toBe("assistant");
    }
  });

  it("renders a transcript within a size limit, keeping the start and the end", () => {
    const t = renderTranscript(history, 1500);
    expect(t.length).toBeLessThan(1700);
    expect(t).toContain("User: build it");
    expect(t).toContain("User: now test it");
    expect(t).toContain("omitted");
    expect(estimateMessages(history)).toBeGreaterThan(2000);
  });
});

describe("compaction in the agent", () => {
  it("/compact replaces older turns with a summary and keeps recent ones", async () => {
    const { root, provider, agent } = await setup([
      { toolCalls: [{ name: "write", input: { path: "a.ts", content: "export const a = 1;\n" } }] },
      { text: "Wrote a.ts." },
      { text: "## Request\nMake a.ts\n## Next steps\nAdd tests" }, // the summary
      { text: "continuing" },
    ]);
    await collect(agent.send("make a.ts"));
    const events = await collect(agent.compact({ focus: "the tests" }));
    expect(events.map((e) => (e.type === "compact" ? e.phase : e.type))).toEqual(["start", "end"]);

    const summaryReq = provider.requests[2]!;
    expect(summaryReq.tools).toEqual([]);
    expect(summaryReq.system).toContain("You summarize a coding-agent conversation");
    expect(text(summaryReq.messages[0]!)).toContain("paying particular attention to: the tests");
    expect(text(summaryReq.messages[0]!)).toContain("User: make a.ts");

    expect(agent.messages[0]!.role).toBe("user");
    const first = text(agent.messages[0]!);
    expect(first).toContain(COMPACT_MARKER);
    expect(first).toContain("Add tests");
    expect(first).toContain("- a.ts"); // the file list, to re-read
    expect(agent.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Wrote a.ts." }] });

    // Edits now need a fresh read, since the file contents left the context.
    await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const r = await defaultTools()
      .find((t) => t.name === "edit")!
      .run({ path: "a.ts", old_string: "1", new_string: "2" } as never, {
        root,
        cwd: root,
        signal: new AbortController().signal,
        fileState: new Map(),
        shell: { cwd: root },
      })
      .catch((e: Error) => e.message);
    expect(String(r)).toMatch(/read/i);

    await collect(agent.send("go on"));
    expect(provider.requests[3]!.messages[0]!.content[0]).toMatchObject({ type: "text" });
  });

  it("compacts automatically near the context limit, before the next request", async () => {
    const { provider, agent } = await setup(
      [
        { toolCalls: [{ name: "ls", input: {} }], usage: { inputTokens: 900 } },
        { text: "summary of the work" },
        { text: "all done", usage: { inputTokens: 200 } },
      ],
      { window: 1000 },
    );
    const events = await collect(agent.send(`list files\n${"context ".repeat(200)}`));
    const phases = events.flatMap((e) => (e.type === "compact" ? [e.phase] : []));
    expect(phases).toEqual(["start", "end"]);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "all done" });
    // The request after compaction starts with the summary.
    expect(text(provider.requests[2]!.messages[0]!)).toContain("summary of the work");
    expect(agent.contextTokens).toBeLessThan(800);
  });

  it("shrinks the context even when the latest turn read several large files at once", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "a.ts"), "// a\n".repeat(3000));
    await fs.writeFile(path.join(root, "b.ts"), "// b\n".repeat(3000));
    const provider = new FakeProvider(
      [
        { toolCalls: [{ name: "read", input: { path: "a.ts" } }, { name: "read", input: { path: "b.ts" } }], usage: { inputTokens: 500 } },
        { text: "summary" },
        { text: "a and b are comments" },
      ],
      "fake",
      12_000,
    );
    const agent = new Agent({ provider, model: "fake", system: "s", tools: defaultTools(), permissions: new Permissions("bypass"), root });
    const events = await collect(agent.send("read a.ts and b.ts"));
    const end = events.find((e) => e.type === "compact" && e.phase === "end") as Extract<AgentEvent, { type: "compact"; phase: "end" }>;
    expect(end).toBeDefined();
    expect(end.after).toBeLessThan(end.before / 2);
    const results = agent.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
    expect(results).toHaveLength(2);
    for (const r of results) expect(String((r as { content: unknown }).content)).toContain("characters removed to save context");
    expect(events.at(-1)).toMatchObject({ type: "done", text: "a and b are comments" });
  });

  it("leaves the history alone when the summary fails", async () => {
    const { agent } = await setup([{ text: "hi" }, { error: new Error("model offline") }]);
    await collect(agent.send("hello"));
    const before = structuredClone(agent.messages);
    const events = await collect(agent.compact());
    expect(events.at(-1)).toMatchObject({ type: "compact", phase: "error", message: expect.stringContaining("model offline") });
    expect(agent.messages).toEqual(before);
  });

  it("can be turned off", async () => {
    const { agent } = await setup([{ toolCalls: [{ name: "ls", input: {} }], usage: { inputTokens: 990 } }, { text: "ok" }], { window: 1000, autoCompact: false });
    const events = await collect(agent.send("x"));
    expect(events.some((e) => e.type === "compact")).toBe(false);
  });

  it("restores a compacted session, its title and task list", async () => {
    const home = await tempDir();
    const env = { FORGE_HOME: home };
    const { root, agent } = await setup([
      { toolCalls: [{ name: "todo_write", input: { todos: [{ content: "Write a.ts", status: "in_progress" }, { content: "Test it", status: "pending" }] } }] },
      { text: "planned" },
      { text: "the summary" },
    ]);
    const session = new Session(root, "fake:fake", { env });
    agent.setRecorder(session);
    await collect(agent.send("set up the project"));
    await collect(agent.compact());

    const loaded = loadSession(session.file);
    expect(loaded.info.title).toBe("set up the project");
    expect(loaded.compactions).toBe(1);
    expect(text(loaded.messages[0]!)).toContain("the summary");
    expect(loaded.messages).toEqual(agent.messages);
    expect(loaded.todos.map((t) => t.status)).toEqual(["in_progress", "pending"]);
  });
});

describe("todo_write", () => {
  it("updates the agent's task list and reports it", async () => {
    const { agent, provider } = await setup([
      {
        toolCalls: [
          {
            name: "todo_write",
            input: { todos: [{ content: "Read the code", status: "completed" }, { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" }] },
          },
        ],
      },
      { text: "ok" },
    ]);
    const events = await collect(agent.send("fix it"));
    expect(events.find((e) => e.type === "todos")).toMatchObject({ todos: [{ status: "completed" }, { activeForm: "Fixing the bug" }] });
    expect(agent.todos).toHaveLength(2);
    const result = provider.requests[1]!.messages.at(-1)!.content[0]!;
    expect(result).toMatchObject({ type: "tool_result", content: expect.stringContaining("2. [~] Fix the bug") });
  });

  it("allows only one task in progress", async () => {
    const { agent } = await setup([
      { toolCalls: [{ name: "todo_write", input: { todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] } }] },
      { text: "ok" },
    ]);
    const events = await collect(agent.send("x"));
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ result: { isError: true, content: expect.stringContaining("exactly one") } });
    expect(agent.todos).toEqual([]);
  });

  it("runs in plan mode without asking", async () => {
    const root = await tempDir();
    const provider = new FakeProvider([{ toolCalls: [{ name: "todo_write", input: { todos: [{ content: "a", status: "pending" }] } }] }, { text: "ok" }]);
    const agent = new Agent({ provider, model: "fake", system: "s", tools: defaultTools(), permissions: new Permissions("plan"), root });
    await collect(agent.send("plan it"));
    expect(agent.todos).toHaveLength(1);
  });
});

describe("/context breakdown", () => {
  it("adds up the parts and draws a bar", async () => {
    const { agent } = await setup([{ text: "a reply" }]);
    await collect(agent.send("a question"));
    const b = contextBreakdown(agent, [{ path: "AGENTS.md", scope: "project", content: "use pnpm" } as never]);
    expect(b.parts.find((p) => p.label === "Tool definitions")!.tokens).toBeGreaterThan(500);
    expect(b.used).toBe(b.parts.reduce((n, p) => n + p.tokens, 0));
    const out = formatContext(b);
    expect(out).toMatch(/^Context: ~[\d.]+k? of 100\.0k tokens/);
    expect(out).toContain("Auto-compact at 80.0k (80.0%)");
    expect(out.split("\n")[1]).toMatch(/^\[.{40}\]$/);
  });
});
