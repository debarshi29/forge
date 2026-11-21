import type { Block, Message } from "../providers/types.js";

/**
 * Append user content, merging into a trailing user message so roles keep
 * alternating (that happens after an interrupted turn). Tool results must
 * come first in a user turn. Used live and when replaying a saved session,
 * so both produce the same history.
 */
export function appendUser(messages: Message[], content: Block[]): void {
  const last = messages.at(-1);
  if (last?.role === "user") {
    const all = [...last.content, ...content];
    last.content = [...all.filter((b) => b.type === "tool_result"), ...all.filter((b) => b.type !== "tool_result")];
  } else {
    messages.push({ role: "user", content });
  }
}
