import { isReminder } from "../agent/loop.js";
import type { Message, ToolResultBlock } from "../providers/types.js";
import type { Tool } from "../tools/types.js";
import type { Item } from "./Transcript.js";

type ItemInput = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

/** Rebuild transcript items from a saved conversation (for /resume). */
export function messagesToItems(messages: Message[], tools: Tool[]): ItemInput[] {
  const results = new Map<string, ToolResultBlock>();
  for (const m of messages) for (const b of m.content) if (b.type === "tool_result") results.set(b.toolUseId, b);

  const items: ItemInput[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim() && !isReminder(b.text)) {
        items.push(m.role === "user" ? { kind: "user", text: b.text } : { kind: "assistant", text: b.text });
      } else if (b.type === "tool_use") {
        const tool = tools.find((t) => t.name === b.name);
        let summary: string;
        try {
          summary = tool?.summarize?.(b.input as never) ?? JSON.stringify(b.input);
        } catch {
          summary = JSON.stringify(b.input);
        }
        const r = results.get(b.id);
        items.push({
          kind: "tool",
          name: b.name,
          summary,
          result: r ? { content: r.content, ...(r.isError ? { isError: true } : {}) } : { content: "(no result)", isError: true },
        });
      }
    }
  }
  return items;
}
