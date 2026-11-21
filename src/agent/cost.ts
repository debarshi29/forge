import type { Usage } from "../providers/types.js";

/** USD per million tokens. Cache writes are billed at 1.25x input (5-minute TTL). */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

// Anthropic first-party list prices.
const PRICES: Array<[RegExp, Price]> = [
  [/^claude-(fable|mythos)-5-2/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/^claude-(fable|mythos)-5(-1)?$/, { input: 10, output: 50, cacheRead: 1 }],
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-opus-(5|4-[5-8])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/^claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/^claude-sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/^claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1 }],
];

/**
 * Price for "anthropic:<id>" or a bare Claude id. Other providers (and local
 * models that happen to be named like Claude) are unpriced.
 */
export function priceFor(model: string): Price | undefined {
  const i = model.indexOf(":");
  if (i !== -1 && model.slice(0, i) !== "anthropic") return undefined;
  const id = i === -1 ? model : model.slice(i + 1);
  return PRICES.find(([re]) => re.test(id))?.[1];
}

/**
 * Cost of one request in USD, or undefined when the model has no known price
 * (e.g. local models). `usage.inputTokens` includes cached tokens.
 */
export function costOf(model: string, usage: Usage): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - read - write);
  return (fresh * p.input + write * p.input * 1.25 + read * p.cacheRead + usage.outputTokens * p.output) / 1_000_000;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
