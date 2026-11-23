import { blockText, estimateTokens } from "./compact.js";
import type { Agent } from "./loop.js";
import type { MemoryFile } from "./memory.js";

export interface ContextPart {
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  parts: ContextPart[];
  /** Estimated total. */
  used: number;
  /** Provider-reported input of the last request, if any. */
  measured: number;
  window: number;
  compactAt: number;
}

/**
 * Where the context goes, estimated from character counts (~4 per token).
 * The provider's own count for the last request is reported alongside.
 */
export function contextBreakdown(agent: Agent, memory: MemoryFile[] = []): ContextBreakdown {
  const memoryChars = memory.reduce((n, m) => n + m.content.length + m.path.length + 20, 0);
  const systemTokens = estimateTokens(agent.system);
  const memoryTokens = Math.min(systemTokens, Math.ceil(memoryChars / 4));
  let user = 0;
  let assistant = 0;
  let calls = 0;
  let results = 0;
  let images = 0;
  for (const m of agent.messages) {
    for (const b of m.content) {
      const n = Math.ceil(blockText(b).length / 4);
      if (b.type === "tool_result") results += n;
      else if (b.type === "tool_use") calls += n;
      else if (b.type === "image") images += 1500;
      else if (b.type === "text") (m.role === "user" ? (user += n) : (assistant += n));
    }
  }
  const parts: ContextPart[] = [
    { label: "System prompt", tokens: systemTokens - memoryTokens },
    { label: "Memory files", tokens: memoryTokens },
    { label: "Tool definitions", tokens: estimateTokens(JSON.stringify(agent.toolSpecs())) },
    { label: "Your messages", tokens: user },
    { label: "Forge's replies", tokens: assistant },
    { label: "Tool calls", tokens: calls },
    { label: "Tool results", tokens: results },
    ...(images ? [{ label: "Images", tokens: images }] : []),
  ];
  const used = parts.reduce((n, p) => n + p.tokens, 0);
  return { parts, used, measured: agent.lastInputTokens, window: agent.contextWindow, compactAt: agent.compactAt };
}

const GLYPHS = ["█", "▓", "▒", "▚", "▞", "▙", "▟", "▜"];

/** A text bar plus a legend, for /context. */
export function formatContext(b: ContextBreakdown, width = 40): string {
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const pct = (n: number) => `${((n / b.window) * 100).toFixed(1)}%`;
  const cells: string[] = [];
  b.parts.forEach((p, i) => {
    const n = Math.round((p.tokens / b.window) * width);
    for (let k = 0; k < n && cells.length < width; k++) cells.push(GLYPHS[i % GLYPHS.length]!);
  });
  const markAt = Math.min(width - 1, Math.round((b.compactAt / b.window) * width));
  while (cells.length < width) cells.push("·");
  cells[markAt] = cells[markAt] === "·" ? "|" : cells[markAt]!;
  const legend = b.parts
    .filter((p) => p.tokens > 0)
    .map((p) => `  ${GLYPHS[b.parts.indexOf(p) % GLYPHS.length]} ${p.label.padEnd(18)} ${fmt(p.tokens).padStart(6)}  ${pct(p.tokens)}`)
    .join("\n");
  const free = Math.max(0, b.window - b.used);
  return [
    `Context: ~${fmt(b.used)} of ${fmt(b.window)} tokens (${pct(b.used)})${b.measured ? ` · last request measured ${fmt(b.measured)}` : ""}`,
    `[${cells.join("")}]`,
    legend,
    `  · Free               ${fmt(free).padStart(6)}  ${pct(free)}`,
    `  | Auto-compact at ${fmt(b.compactAt)} (${pct(b.compactAt)}). /compact [focus] to compact now.`,
  ].join("\n");
}
