import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/loop.js";
import { costOf } from "../src/agent/cost.js";
import { Permissions } from "../src/permissions/index.js";
import { fromAnthropicMessage } from "../src/providers/anthropic.js";
import { FakeProvider } from "../src/providers/fake.js";
import { GeminiProvider, sanitizeSchema, toGeminiContents } from "../src/providers/gemini.js";
import { extractTextToolCalls, extractToolCalls, OpenAIProvider, toOpenAIMessages } from "../src/providers/openai.js";
import { resolveModel } from "../src/providers/registry.js";
import type { Message, StreamEvent, StreamRequest } from "../src/providers/types.js";
import { defaultTools, toToolSpec } from "../src/tools/registry.js";

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const req = (messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]): StreamRequest => ({
  model: "m",
  system: "sys",
  messages,
  tools: defaultTools().slice(0, 1).map(toToolSpec),
});

// ---------------------------------------------------------------- OpenAI

function fakeOpenAI(chunks: unknown[], capture: { params?: unknown } = {}): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: unknown) => {
          capture.params = params;
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  } as unknown as OpenAI;
}

const chunk = (delta: object, finish: string | null = null, usage?: object) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

describe("OpenAI adapter", () => {
  it("accumulates streamed tool calls and maps usage", async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const p = new OpenAIProvider({
      client: fakeOpenAI(
        [
          chunk({ content: "Let me look." }),
          chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"pa' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
          chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "read", arguments: "{bad json" } }] }),
          chunk({}, "tool_calls"),
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } },
        ],
        capture as { params?: unknown },
      ),
    });
    const events = await collect(p.stream(req()));
    const end = events.at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(end.stop).toBe("tool_use");
    expect(end.message.content).toEqual([
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "call_a", name: "read", input: { path: "a.ts" } },
      { type: "tool_use", id: "call_b", name: "read", input: "{bad json" },
    ]);
    expect(end.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 });
    expect(capture.params).toMatchObject({ max_completion_tokens: 32000, stream_options: { include_usage: true } });
    expect((capture.params!.messages as Array<{ role: string }>)[0]).toEqual({ role: "system", content: "sys" });
  });

  it("uses max_tokens for compatible servers and maps length/refusal", async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const p = new OpenAIProvider({ compat: true, client: fakeOpenAI([chunk({ content: "abc" }, "length")], capture as { params?: unknown }) });
    const end = (await collect(p.stream(req()))).at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(end.stop).toBe("max_tokens");
    expect(capture.params).toMatchObject({ max_tokens: 8192 });

    const r = new OpenAIProvider({ client: fakeOpenAI([chunk({ refusal: "I can't help with that." }, "stop")]) });
    const rend = (await collect(r.stream(req()))).at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(rend.stop).toBe("refusal");
  });

  it("recovers JSON-text tool calls from local models, and only those", async () => {
    const names = new Set(["write", "read"]);
    expect(extractTextToolCalls('{"name": "write", "arguments": {"path": "a", "content": "x"}}', names)).toEqual([
      { name: "write", args: { path: "a", content: "x" } },
    ]);
    expect(extractTextToolCalls('```json\n{"name":"read","parameters":"{\\"path\\":\\"b\\"}"}\n```', names)).toEqual([
      { name: "read", args: { path: "b" } },
    ]);
    expect(extractTextToolCalls('{"name":"read","arguments":{}}\n{"name":"write","arguments":{}}', names)).toHaveLength(2);
    expect(extractTextToolCalls('Here you go: {"name":"read","arguments":{}}', names)).toEqual([]);
    expect(extractTextToolCalls('{"name":"rm_rf","arguments":{}}', names)).toEqual([]);

    const compat = new OpenAIProvider({ compat: true, client: fakeOpenAI([chunk({ content: '{"name": "read", "arguments": {"path": "a.ts"}}' }, "stop")]) });
    const end = (await collect(compat.stream(req()))).at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(end.stop).toBe("tool_use");
    expect(end.message.content).toEqual([{ type: "tool_use", id: expect.any(String), name: "read", input: { path: "a.ts" } }]);

    const strict = new OpenAIProvider({ client: fakeOpenAI([chunk({ content: '{"name": "read", "arguments": {}}' }, "stop")]) });
    const strictEnd = (await collect(strict.stream(req()))).at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(strictEnd.stop).toBe("end_turn");
  });

  it("finds text tool calls inside prose, tags and fences, keeping the prose", () => {
    const names = new Set(["write", "read"]);
    expect(extractToolCalls('Sure, writing it now.\n```json\n{"name": "write", "arguments": {"path": "a"}}\n```\nDone soon.', names)).toEqual({
      calls: [{ name: "write", args: { path: "a" } }],
      rest: "Sure, writing it now.\n\nDone soon.",
    });
    expect(extractToolCalls('<tool_call>\n{"name": "read", "arguments": {"path": "b"}}\n</tool_call>', names).calls).toHaveLength(1);
    expect(extractToolCalls('Reading:\n{"name": "read", "arguments": {}}', names)).toEqual({
      calls: [{ name: "read", args: {} }],
      rest: "Reading:",
    });
    // Example code that isn't a call for a known tool stays as text.
    const prose = 'Config looks like:\n```json\n{"name": "my-app", "version": 1}\n```';
    expect(extractToolCalls(prose, names)).toEqual({ calls: [], rest: prose.trim() });
  });

  it("never streams text-form tool calls to the screen", async () => {
    const reply = 'Let me create it.\n```json\n{"name": "read", "arguments": {"path": "a.ts"}}\n```';
    // Split into awkward chunks, as a real stream would.
    const chunks = reply.match(/.{1,3}/gs)!.map((c) => chunk({ content: c }));
    const p = new OpenAIProvider({ compat: true, client: fakeOpenAI([...chunks, chunk({}, "stop")]) });
    const events = await collect(p.stream(req()));
    const shown = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(shown).toBe("Let me create it.\n");
    expect(shown).not.toContain("{");
    const end = events.at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(end.message.content).toEqual([
      { type: "text", text: "Let me create it." },
      { type: "tool_use", id: expect.any(String), name: "read", input: { path: "a.ts" } },
    ]);
  });

  it("still streams ordinary answers in full, including held-back code", async () => {
    const reply = "Here is an example:\n```ts\nconst x = { a: 1 };\n```\nThat's it.";
    const chunks = reply.match(/.{1,4}/gs)!.map((c) => chunk({ content: c }));
    const p = new OpenAIProvider({ compat: true, client: fakeOpenAI([...chunks, chunk({}, "stop")]) });
    const events = await collect(p.stream(req()));
    const shown = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(shown).toBe(reply);
    const end = events.at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(end.stop).toBe("end_turn");
  });

  it("maps neutral history to chat messages", () => {
    const out = toOpenAIMessages([
      { role: "user", content: [{ type: "text", text: "look" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", provider: "anthropic", payload: {} },
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "read", input: { path: "x.png" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: [{ type: "image", mediaType: "image/png", data: "AAA" }] },
          { type: "text", text: "and?" },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: "user", content: "look" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: '{"path":"x.png"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "[image attached in the next message]" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "text", text: "and?" },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------- Gemini

function fakeGemini(responses: unknown[], capture: { params?: unknown } = {}): GoogleGenAI {
  return {
    models: {
      generateContentStream: async (params: unknown) => {
        capture.params = params;
        return (async function* () {
          yield* responses;
        })();
      },
    },
  } as unknown as GoogleGenAI;
}

describe("Gemini adapter", () => {
  it("streams thoughts, synthesizes call ids and keeps thoughtSignature verbatim", async () => {
    const capture: { params?: Record<string, unknown> } = {};
    const parts = [
      { text: "considering", thought: true },
      { functionCall: { name: "read", args: { path: "a.ts" } }, thoughtSignature: "SIG==" },
    ];
    const p = new GeminiProvider({
      client: fakeGemini(
        [
          { candidates: [{ content: { role: "model", parts: [parts[0]] } }] },
          {
            candidates: [{ content: { role: "model", parts: [parts[1]] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 },
          },
        ],
        capture as { params?: unknown },
      ),
    });
    const events = await collect(p.stream(req()));
    expect(events[0]).toEqual({ type: "thinking_delta", text: "considering" });
    const end = events.at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(end.stop).toBe("tool_use");
    expect(end.usage).toMatchObject({ inputTokens: 50, outputTokens: 15 });
    const call = end.message.content.find((b) => b.type === "tool_use")!;
    expect(call).toMatchObject({ name: "read", input: { path: "a.ts" } });
    expect((call as { id: string }).id).toMatch(/^gemini_call_/);

    // Tool declarations are sanitized and sent as JSON schema.
    const decl = (capture.params!.config as { tools: Array<{ functionDeclarations: Array<{ parametersJsonSchema: object }> }> }).tools[0]!
      .functionDeclarations[0]!;
    expect(JSON.stringify(decl.parametersJsonSchema)).not.toContain("additionalProperties");

    // Round trip: the model turn replays verbatim; the response carries the name, not the synthetic id.
    const contents = toGeminiContents([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      end.message,
      { role: "user", content: [{ type: "tool_result", toolUseId: (call as { id: string }).id, content: "file text" }] },
    ]);
    expect(contents[1]).toEqual({ role: "model", parts });
    expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "read", response: { output: "file text" } } }] });
  });

  it("maps safety blocks to refusal and rebuilds other providers' turns", async () => {
    const p = new GeminiProvider({ client: fakeGemini([{ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }]) });
    const end = (await collect(p.stream(req()))).at(-1) as Extract<StreamEvent, { type: "message_end" }>;
    expect(end.stop).toBe("refusal");

    const claudeTurn = fromAnthropicMessage({
      model: "claude-opus-5-5",
      content: [
        { type: "thinking", thinking: "secret", signature: "s" },
        { type: "tool_use", id: "toolu_9", name: "ls", input: {} },
      ],
    } as never);
    const contents = toGeminiContents([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      claudeTurn,
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_9", content: "a/", isError: true }] },
    ]);
    expect(contents[1]).toEqual({ role: "model", parts: [{ functionCall: { id: "toolu_9", name: "ls", args: {} } }] });
    expect(contents[2]!.parts![0]).toEqual({ functionResponse: { id: "toolu_9", name: "ls", response: { error: "a/" } } });
  });

  it("sanitizes schemas without touching property names", () => {
    expect(
      sanitizeSchema({
        $schema: "x",
        type: "object",
        additionalProperties: false,
        properties: { additionalProperties: { type: "string" }, nested: { type: "object", additionalProperties: true } },
      }),
    ).toEqual({ type: "object", properties: { additionalProperties: { type: "string" }, nested: { type: "object" } } });
  });
});

// ---------------------------------------------------------------- registry & switching

describe("model registry", () => {
  it("resolves specs, aliases and bare ids", () => {
    expect(resolveModel("anthropic:claude-opus-5-5")).toMatchObject({ model: "claude-opus-5-5", spec: "anthropic:claude-opus-5-5" });
    expect(resolveModel("claude-sonnet-5-5").spec).toBe("anthropic:claude-sonnet-5-5");
    expect(resolveModel("google:gemini-2.5-pro").provider.name).toBe("gemini");
    expect(resolveModel("ollama:qwen3-coder:30b")).toMatchObject({ model: "qwen3-coder:30b", spec: "ollama:qwen3-coder:30b" });
    expect(resolveModel("ollama:qwen3").provider.capabilities("qwen3").contextWindow).toBe(32_768);
    expect(() => resolveModel("nope:x")).toThrow(/Unknown provider/);
    expect(() => resolveModel("llama3")).toThrow(/provider:model/);
  });

  it("prices only Anthropic models", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(costOf("anthropic:claude-opus-5-5", u)).toBeCloseTo(4);
    expect(costOf("ollama:claude-opus-5-5", u)).toBeUndefined();
  });
});

describe("switching models mid-session", () => {
  it("sends the full history to the new provider and keeps stored turns intact", async () => {
    const a = new FakeProvider([{ thinking: "hmm", text: "first answer" }], "anthropic");
    const b = new FakeProvider([{ text: "second answer" }], "gemini");
    const agent = new Agent({ provider: a, model: "claude-x", system: "s1", tools: [], permissions: new Permissions("bypass"), root: process.cwd() });
    for await (const _ of agent.send("one")) void _;
    const stored = structuredClone(agent.messages);

    agent.setModel(b, "gemini-x", "s2");
    expect(agent.modelSpec).toBe("gemini:gemini-x");
    for await (const _ of agent.send("two")) void _;
    expect(b.requests[0]).toMatchObject({ model: "gemini-x", system: "s2" });
    expect(b.requests[0]!.messages.slice(0, 2)).toEqual(stored);
    expect(agent.messages[1]).toEqual(stored[1]); // never edited
  });
});
