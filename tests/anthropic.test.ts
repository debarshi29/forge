import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { fromAnthropicMessage, toAnthropicMessages } from "../src/providers/anthropic.js";
import type { Message } from "../src/providers/types.js";

const native = [
  { type: "thinking", thinking: "let me look", signature: "sig123" },
  { type: "text", text: "Reading.", citations: null },
  { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } },
] as unknown as Anthropic.Beta.Messages.BetaContentBlock[];

describe("anthropic mapping", () => {
  it("keeps thinking opaque and replays assistant turns verbatim", () => {
    const msg = fromAnthropicMessage({ model: "claude-opus-5-5", content: native } as Anthropic.Beta.Messages.BetaMessage);
    expect(msg.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(msg.content[0]).toMatchObject({ provider: "anthropic", text: "let me look" });

    const [out] = toAnthropicMessages([msg]);
    expect(out!.content).toBe(native); // same array, byte-for-byte
  });

  it("maps user content and drops foreign thinking", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", provider: "gemini", payload: { thoughtSignature: "x" } },
          { type: "tool_use", id: "c1", name: "ls", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "src/", isError: true }] },
    ];
    const out = toAnthropicMessages(history);
    expect(out[1]!.content).toEqual([{ type: "tool_use", id: "c1", name: "ls", input: {} }]);
    expect(out[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "c1", is_error: true, content: "src/" }]);
  });
});
