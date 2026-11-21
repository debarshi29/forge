import type { Block, Message, Provider, Usage } from "../providers/types.js";

/** Start of the summary message that replaces compacted history. */
export const COMPACT_MARKER = "This conversation was compacted to save context.";

/** Rough token estimate: ~4 characters per token for English and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function blockText(b: Block): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "tool_use":
      return `${b.name} ${JSON.stringify(b.input)}`;
    case "tool_result":
      return typeof b.content === "string" ? b.content : b.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
    case "thinking":
      return "";
    case "image":
      return "[image]";
  }
}

export function estimateMessages(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) for (const b of m.content) chars += blockText(b).length + (b.type === "image" ? 6000 : 0);
  return Math.ceil(chars / 4) + messages.length * 4;
}

/**
 * Where to cut: keep messages[cut..] verbatim. The kept part starts at an
 * assistant message, so every tool_use keeps its tool_result and the new
 * history (summary as a user message, then the kept part) still alternates.
 * Returns undefined when there is nothing worth summarizing.
 */
export function chooseCut(messages: Message[], keepBudget: number): number | undefined {
  const starts: number[] = [];
  for (let i = 1; i < messages.length; i++) if (messages[i]!.role === "assistant") starts.push(i);
  if (!starts.length) return undefined;
  // Keep the longest suffix that fits the budget, but always summarize something.
  let cut = starts.at(-1)!;
  for (let k = starts.length - 1; k >= 0; k--) {
    if (estimateMessages(messages.slice(starts[k]!)) > keepBudget) break;
    cut = starts[k]!;
  }
  return cut;
}

/**
 * Trim long tool results in kept turns until they fit `budget` tokens, keeping
 * each result's start and end. Assistant messages are never touched. Used when
 * the most recent turn alone is too big (e.g. several large files read at once).
 */
export function shrinkToolResults(messages: Message[], budget: number): Message[] {
  if (estimateMessages(messages) <= budget) return messages;
  const shrink = (cap: number): Message[] =>
    messages.map((m) =>
      m.role !== "user"
        ? m
        : {
            ...m,
            content: m.content.map((b) => {
              if (b.type !== "tool_result" || typeof b.content !== "string" || b.content.length <= cap) return b;
              const head = Math.floor(cap * 0.6);
              const tail = cap - head;
              return {
                ...b,
                content: `${b.content.slice(0, head)}\n[… ${b.content.length - cap} characters removed to save context; run the tool again if you need them …]\n${b.content.slice(-tail)}`,
              };
            }),
          },
    );
  // Binary-search the largest per-result cap that fits (but keep at least 600 characters each).
  let lo = 600;
  let hi = Math.max(lo, ...messages.flatMap((m) => m.content.map((b) => (b.type === "tool_result" && typeof b.content === "string" ? b.content.length : 0))));
  if (estimateMessages(shrink(lo)) > budget) return shrink(lo);
  while (hi - lo > 200) {
    const mid = Math.floor((lo + hi) / 2);
    if (estimateMessages(shrink(mid)) <= budget) lo = mid;
    else hi = mid;
  }
  return shrink(lo);
}

/** Render history as a plain transcript for the summarizer (provider-neutral, no tool pairing rules). */
export function renderTranscript(messages: Message[], maxChars: number): string {
  const perResult = 1500;
  const lines: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) {
        lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${b.text.trim()}`);
      } else if (b.type === "tool_use") {
        lines.push(`Assistant called ${b.name}: ${clip(JSON.stringify(b.input), 600)}`);
      } else if (b.type === "tool_result") {
        lines.push(`Tool result${b.isError ? " (error)" : ""}: ${clip(blockText(b), perResult)}`);
      } else if (b.type === "image") {
        lines.push(`${m.role === "user" ? "User" : "Assistant"}: [image]`);
      }
    }
  }
  let text = lines.join("\n\n");
  if (text.length > maxChars) {
    // Keep the start (the original request) and the most recent work.
    const head = Math.floor(maxChars * 0.3);
    text = `${text.slice(0, head)}\n\n[… ${text.length - maxChars} characters of older transcript omitted …]\n\n${text.slice(-(maxChars - head))}`;
  }
  return text;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.floor(max * 0.7))} […] ${s.slice(-Math.floor(max * 0.2))}`;
}

const SUMMARY_SYSTEM = `You summarize a coding-agent conversation so the agent can continue the work without the original transcript. Be specific and factual; keep exact file paths, function names, commands, error messages and decisions. Write Markdown with these sections:

## Request
What the user asked for, including constraints and preferences they stated.
## Done so far
What was changed, file by file, and what was verified (tests, builds).
## Current state
Where the work stands right now, including anything broken or half-finished.
## Open problems
Errors not yet fixed and questions not yet answered.
## Next steps
The specific next actions, in order.

Don't invent anything that isn't in the transcript. Don't address the user.`;

export interface SummaryRequest {
  provider: Provider;
  model: string;
  messages: Message[];
  contextWindow: number;
  focus?: string;
  signal: AbortSignal;
}

/** Ask the model for a summary of the given history. */
export async function summarize(req: SummaryRequest): Promise<{ summary: string; usage: Usage }> {
  // Leave room for the system prompt and the summary itself.
  const budgetChars = Math.max(4000, Math.floor(req.contextWindow * 0.6) * 4);
  const transcript = renderTranscript(req.messages, budgetChars);
  const ask = `Summarize this conversation${req.focus ? `, paying particular attention to: ${req.focus}` : ""}.\n\n<transcript>\n${transcript}\n</transcript>`;
  let text = "";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  for await (const ev of req.provider.stream({
    model: req.model,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: ask }] }],
    tools: [],
    maxTokens: 4000,
    signal: req.signal,
  })) {
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "message_end") {
      usage = ev.usage;
      text = ev.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("") || text;
    }
  }
  const summary = text.trim();
  if (!summary) throw new Error("the model returned an empty summary");
  return { summary, usage };
}

/** The user message that replaces the summarized history. */
export function summaryMessage(summary: string, extras: { files: string[]; todos?: string }): Message {
  const parts = [
    `${COMPACT_MARKER} Summary of the earlier part:`,
    summary,
    extras.files.length
      ? `Files read or changed earlier (their contents are no longer in context; read one again only if you need it, e.g. before editing it):\n${extras.files.map((f) => `- ${f}`).join("\n")}`
      : "",
    extras.todos ? `Current task list:\n${extras.todos}` : "",
    "Continue from where the work left off.",
  ].filter(Boolean);
  return { role: "user", content: [{ type: "text", text: `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>` }] };
}
