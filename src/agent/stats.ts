import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { forgeHome } from "../config/index.js";
import type { Message, Usage } from "../providers/types.js";
import { costOf, formatCost } from "./cost.js";
import { isReminder } from "./loop.js";
import { formatTokens } from "../ui/format.js";

/** One model request, from a session log. */
export interface UsageEvent {
  at: number;
  model: string;
  usage: Usage;
  session: string;
  root: string;
}

/** One message, for activity stats. */
export interface MessageEvent {
  at: number;
  session: string;
  root: string;
  message: Message;
}

export interface History {
  usage: UsageEvent[];
  messages: MessageEvent[];
  sessions: Array<{ id: string; root: string; created: number }>;
}

/**
 * Read every session log under ~/.forge/sessions. Records written before
 * timestamps were added take their session's creation time.
 */
export function readHistory(env: NodeJS.ProcessEnv = process.env, opts: { root?: string } = {}): History {
  const out: History = { usage: [], messages: [], sessions: [] };
  const base = path.join(forgeHome(env), "sessions");
  let dirs: string[];
  try {
    dirs = readdirSync(base);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(path.join(base, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(base, d, f);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let id = f.replace(/\.jsonl$/, "");
      let root = "";
      let created: number | undefined;
      const usage: UsageEvent[] = [];
      const messages: MessageEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let rec: { t?: string; at?: number; id?: string; root?: string; created?: string; model?: string; u?: Usage; m?: Message };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.t === "meta") {
          id = rec.id ?? id;
          root = rec.root ?? "";
          created = rec.created ? Date.parse(rec.created) : undefined;
        } else if (rec.t === "usage" && rec.u && rec.model) {
          usage.push({ at: rec.at ?? NaN, model: rec.model, usage: rec.u, session: id, root });
        } else if (rec.t === "msg" && rec.m) {
          messages.push({ at: rec.at ?? NaN, session: id, root, message: rec.m });
        }
      }
      const fallback = created ?? safeMtime(file);
      if (opts.root && path.resolve(root).toLowerCase() !== path.resolve(opts.root).toLowerCase()) continue;
      for (const u of usage) if (Number.isNaN(u.at)) u.at = fallback;
      for (const m of messages) if (Number.isNaN(m.at)) m.at = fallback;
      out.usage.push(...usage.map((u) => ({ ...u, root })));
      out.messages.push(...messages.map((m) => ({ ...m, root })));
      out.sessions.push({ id, root, created: fallback });
    }
  }
  return out;
}

function safeMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Requests whose model has no known price. */
  unpriced: number;
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
}

export function addUsage(t: UsageTotals, model: string, u: Usage): void {
  t.requests++;
  t.input += u.inputTokens;
  t.output += u.outputTokens;
  t.cacheRead += u.cacheReadTokens ?? 0;
  t.cacheWrite += u.cacheWriteTokens ?? 0;
  const c = costOf(model, u);
  if (c === undefined) t.unpriced++;
  else t.cost += c;
}

/** Local calendar day, "2026-11-23". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(now: number, daysAgo = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

function startOfMonth(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function line(label: string, t: UsageTotals, width = 14): string {
  const cache = t.cacheRead || t.cacheWrite ? ` · cache ${formatTokens(t.cacheRead)} read, ${formatTokens(t.cacheWrite)} written` : "";
  const cost = t.cost > 0 ? formatCost(t.cost) : t.requests ? "$0 (local)" : "-";
  return `${label.padEnd(width)}${String(t.requests).padStart(6)} req  ${formatTokens(t.input).padStart(7)} in  ${formatTokens(t.output).padStart(7)} out  ${cost}${cache}`;
}

/** /usage: totals per period, then by model and by day. */
export function usageReport(h: History, opts: { now?: number; days?: number; session?: { id: string; label: string } } = {}): string {
  const now = opts.now ?? Date.now();
  const periods: Array<[string, number]> = [
    ["Today", startOfDay(now)],
    ["Last 7 days", startOfDay(now, 6)],
    ["This month", startOfMonth(now)],
    ["All time", 0],
  ];
  const out: string[] = [];
  if (opts.session) {
    const t = emptyTotals();
    for (const u of h.usage) if (u.session === opts.session.id) addUsage(t, u.model, u.usage);
    out.push(line(opts.session.label, t));
  }
  for (const [label, from] of periods) {
    const t = emptyTotals();
    for (const u of h.usage) if (u.at >= from) addUsage(t, u.model, u.usage);
    out.push(line(label, t));
  }

  const byModel = new Map<string, UsageTotals>();
  for (const u of h.usage) {
    if (u.at < startOfMonth(now)) continue;
    const t = byModel.get(u.model) ?? emptyTotals();
    addUsage(t, u.model, u.usage);
    byModel.set(u.model, t);
  }
  if (byModel.size) {
    const w = Math.max(14, ...[...byModel.keys()].map((k) => k.length + 2));
    out.push("", "This month by model:", ...[...byModel].sort((a, b) => b[1].cost - a[1].cost || b[1].input - a[1].input).map(([m, t]) => line(m, t, w)));
  }

  const days = opts.days ?? 14;
  const byDay = new Map<string, UsageTotals>();
  for (const u of h.usage) {
    if (u.at < startOfDay(now, days - 1)) continue;
    const k = dayKey(u.at);
    const t = byDay.get(k) ?? emptyTotals();
    addUsage(t, u.model, u.usage);
    byDay.set(k, t);
  }
  if (byDay.size) {
    const keys = Array.from({ length: days }, (_, i) => dayKey(startOfDay(now, days - 1 - i)));
    const tokens = keys.map((k) => (byDay.get(k)?.input ?? 0) + (byDay.get(k)?.output ?? 0));
    const max = Math.max(...tokens);
    out.push("", `Last ${days} days (tokens): ${sparkline(tokens)}  ${keys[0]!.slice(5)} → ${keys.at(-1)!.slice(5)}`);
    for (const [i, k] of keys.entries()) {
      const t = byDay.get(k);
      if (!t) continue;
      out.push(`  ${k}  ${formatTokens(tokens[i]!).padStart(7)}  ${"█".repeat(Math.max(1, Math.round((tokens[i]! / max) * 20)))}${t.cost > 0 ? `  ${formatCost(t.cost)}` : ""}`);
    }
  }
  if (!h.usage.length) out.push("", "No usage recorded yet (sessions are saved under ~/.forge/sessions).");
  return out.join("\n");
}

/** A user turn the person typed (not tool results or harness reminders). */
function isPrompt(m: Message): boolean {
  return m.role === "user" && m.content.some((b) => b.type === "text" && b.text.trim() && !isReminder(b.text));
}

const SHADES = [" ", "░", "▒", "▓", "█"];
const BARS = "▁▂▃▄▅▆▇█";

/** One character per value, scaled to the largest. */
export function sparkline(values: number[]): string {
  const max = Math.max(0, ...values);
  return values.map((v) => (v <= 0 || max === 0 ? "·" : BARS[Math.min(BARS.length - 1, Math.floor((v / max) * (BARS.length - 1)))])).join("");
}

/** /stats: activity, tools, files, turns per prompt, and a weekday × hour heatmap. */
export function statsReport(h: History, opts: { now?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const prompts = h.messages.filter((e) => isPrompt(e.message));
  const tools = new Map<string, number>();
  const files = new Map<string, number>();
  let assistantTurns = 0;
  for (const e of h.messages) {
    if (e.message.role !== "assistant") continue;
    assistantTurns++;
    for (const b of e.message.content) {
      if (b.type !== "tool_use") continue;
      tools.set(b.name, (tools.get(b.name) ?? 0) + 1);
      const p = (b.input as { path?: unknown } | null)?.path;
      if (typeof p === "string" && ["read", "write", "edit"].includes(b.name)) {
        const rel = path.isAbsolute(p) && e.root ? path.relative(e.root, p) || p : p;
        const key = rel.split(path.sep).join("/");
        files.set(key, (files.get(key) ?? 0) + 1);
      }
    }
  }
  const out: string[] = [];
  const activeDays = new Set(prompts.map((p) => dayKey(p.at)));
  const sessions30 = h.sessions.filter((s) => s.created >= startOfDay(now, 29)).length;
  out.push(
    `Sessions: ${h.sessions.length} (${sessions30} in the last 30 days) · prompts: ${prompts.length} · active days: ${activeDays.size}`,
    `Model requests per prompt: ${prompts.length ? (assistantTurns / prompts.length).toFixed(1) : "-"}`,
  );

  // Sessions per day, last 14 days.
  const perDay = new Map<string, number>();
  for (const s of h.sessions) perDay.set(dayKey(s.created), (perDay.get(dayKey(s.created)) ?? 0) + 1);
  const recent = Array.from({ length: 14 }, (_, i) => dayKey(startOfDay(now, 13 - i)));
  const counts = recent.map((d) => perDay.get(d) ?? 0);
  out.push(`Sessions, last 14 days: ${sparkline(counts)}  ${recent[0]!.slice(5)} → ${recent.at(-1)!.slice(5)} (busiest: ${Math.max(...counts)})`);

  const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  if (tools.size) {
    const w = Math.max(...[...tools.keys()].map((k) => k.length)) + 2;
    out.push("", "Tools:", ...top(tools, 12).map(([k, v]) => `  ${k.padEnd(w)}${String(v).padStart(5)}`));
  }
  if (files.size) out.push("", "Most-touched files:", ...top(files, 10).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`));

  // When you work: prompts by weekday and hour.
  if (prompts.length) {
    const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const p of prompts) {
      const d = new Date(p.at);
      grid[(d.getDay() + 6) % 7]![d.getHours()]!++;
    }
    const max = Math.max(...grid.flat());
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    out.push("", "Activity (prompts by hour):", `      ${"0     6     12    18"}`);
    grid.forEach((row, i) => out.push(`  ${names[i]} ${row.map((n) => SHADES[n === 0 ? 0 : Math.max(1, Math.ceil((n / max) * 4))]).join("")}`));
  }
  return out.join("\n");
}
