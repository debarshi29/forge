import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent/loop.js";
import { Permissions, type AskFn } from "../src/permissions/index.js";
import { ProviderStreamError } from "../src/providers/errors.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import { defaultTools } from "../src/tools/registry.js";
import { defineTool, type Tool } from "../src/tools/types.js";
import { tempDir } from "./helpers.js";

async function setup(turns: FakeTurn[], opts: { tools?: Tool[]; ask?: AskFn; mode?: "default" | "bypass" | "plan" } = {}) {
  const root = await tempDir();
  const provider = new FakeProvider(turns);
  const agent = new Agent({
    provider,
    model: "fake",
    system: "test",
    tools: opts.tools ?? defaultTools(),
    permissions: new Permissions(opts.mode ?? "bypass", opts.ask),
    root,
  });
  return { root, provider, agent };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("agent loop", () => {
  it("runs a tool and feeds the result back", async () => {
    const { root, provider, agent } = await setup([
      { text: "Creating it.", toolCalls: [{ name: "write", input: { path: "hello.ts", content: "console.log('hi')\n" } }] },
      { text: "Done." },
    ]);
    const events = await collect(agent.send("make hello.ts"));
    expect(await fs.readFile(path.join(root, "hello.ts"), "utf8")).toBe("console.log('hi')\n");
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "end_turn", text: "Done." });

    const second = provider.requests[1]!;
    expect(second.messages).toHaveLength(3);
    const results = second.messages[2]!;
    expect(results.role).toBe("user");
    expect(results.content[0]).toMatchObject({ type: "tool_result", toolUseId: "call_1_0" });
    expect(results.content[0]).not.toHaveProperty("isError");
  });

  it("returns all parallel results in one user message, in call order", async () => {
    const order: string[] = [];
    const slow = defineTool({
      name: "slow",
      description: "",
      schema: z.object({ ms: z.number(), tag: z.string() }),
      readOnly: true,
      async run(i) {
        await new Promise((r) => setTimeout(r, i.ms));
        order.push(i.tag);
        return { content: i.tag };
      },
    });
    const { provider, agent } = await setup(
      [
        { toolCalls: [{ name: "slow", input: { ms: 60, tag: "A" } }, { name: "slow", input: { ms: 5, tag: "B" } }] },
        { text: "ok" },
      ],
      { tools: [slow as Tool] },
    );
    await collect(agent.send("go"));
    expect(order).toEqual(["B", "A"]); // ran concurrently
    const msg = provider.requests[1]!.messages[2]!;
    expect(msg.content.map((b) => (b.type === "tool_result" ? b.content : null))).toEqual(["A", "B"]);
  });

  it("turns invalid input, unknown tools and denials into error results", async () => {
    const { provider, agent } = await setup(
      [
        {
          toolCalls: [
            { name: "read", input: { nope: 1 } },
            { name: "teleport", input: {} },
            { name: "bash", input: { command: "echo hi" } },
          ],
        },
        { text: "ok" },
      ],
      { mode: "default", ask: async () => ({ kind: "no", reason: "not now" }) },
    );
    await collect(agent.send("go"));
    const [invalid, unknown, denied] = provider.requests[1]!.messages[2]!.content as Array<{ content: string; isError?: boolean }>;
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid!.content).toMatch(/Invalid input for read/);
    expect(unknown!.content).toMatch(/Unknown tool/);
    expect(denied!.content).toMatch(/not now/);
  });

  it("never runs tool calls from a max_tokens-truncated turn", async () => {
    const { root, provider, agent } = await setup([
      { toolCalls: [{ name: "write", input: { path: "x.txt", content: "partial" } }], stop: "max_tokens" },
      { text: "retrying smaller" },
    ]);
    await collect(agent.send("go"));
    await expect(fs.stat(path.join(root, "x.txt"))).rejects.toThrow();
    const r = provider.requests[1]!.messages[2]!.content[0] as { content: string; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/max_tokens/);
  });

  it("re-issues the turn on retryable stream errors", async () => {
    const { agent } = await setup([{ error: new ProviderStreamError("dropped", true) }, { text: "hi" }]);
    const events = await collect(agent.send("go"));
    expect(events.some((e) => e.type === "retry")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "hi" });
  });

  it("aborting mid-tool leaves a valid history", async () => {
    const hang = defineTool({
      name: "hang",
      description: "",
      schema: z.object({}),
      readOnly: false,
      run: (_i, ctx) =>
        new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    const { agent } = await setup([{ toolCalls: [{ name: "hang", input: {} }, { name: "hang", input: {} }] }], {
      tools: [hang as Tool],
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const events = await collect(agent.send("go", ac.signal));
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "aborted" });
    const last = agent.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toHaveLength(2);
    expect(last.content.every((b) => b.type === "tool_result" && b.isError)).toBe(true);
  });

  it("plan mode blocks mutating tools", async () => {
    const { root, agent } = await setup(
      [{ toolCalls: [{ name: "write", input: { path: "x.txt", content: "x" } }] }, { text: "ok" }],
      { mode: "plan" },
    );
    await collect(agent.send("go"));
    await expect(fs.stat(path.join(root, "x.txt"))).rejects.toThrow();
  });

  it("stops on refusal", async () => {
    const { provider, agent } = await setup([{ text: "", stop: "refusal" }]);
    const events = await collect(agent.send("go"));
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "refusal" });
    expect(provider.requests).toHaveLength(1);
  });

  it("accumulates usage", async () => {
    const { agent } = await setup([
      { toolCalls: [{ name: "ls", input: {} }], usage: { inputTokens: 100, outputTokens: 7 } },
      { text: "ok", usage: { inputTokens: 150, outputTokens: 3 } },
    ]);
    await collect(agent.send("go"));
    expect(agent.usage).toMatchObject({ inputTokens: 250, outputTokens: 10 });
    expect(agent.lastInputTokens).toBe(150);
  });
});
