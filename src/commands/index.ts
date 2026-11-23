import type { Agent } from "../agent/loop.js";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/index.js";
import { formatCost, priceFor } from "../agent/cost.js";
import type { MemoryFile } from "../agent/memory.js";
import { formatTokens } from "../ui/format.js";
import { THEMES } from "../ui/theme.js";
import { contextBreakdown, formatContext } from "../agent/context.js";
import { formatTodos } from "../tools/todo.js";
import { readHistory, statsReport, usageReport } from "../agent/stats.js";
import { parseGoalArgs, type GoalOptions } from "../agent/goal.js";

export interface CommandContext {
  agent: Agent;
  /** Project root (for /usage project). */
  root?: string;
  env?: NodeJS.ProcessEnv;
  print(text: string, tone?: "info" | "warn" | "error"): void;
  clearTranscript(): void;
  /** Point persistence at a fresh session file (no-op when sessions are off). */
  startNewSession(): void;
  openResume(): void;
  setMode(mode: PermissionMode): void;
  exit(): void;
  allowBypass: boolean;
  memory: MemoryFile[];
  /** Resolve a "provider:model" spec and switch the agent to it; rejects on bad specs. */
  switchModel?(spec: string): Promise<void | { warning?: string }>;
  /** Open the interactive model list. */
  openModelPicker?(): void;
  /** Open the theme picker (live preview). */
  openThemePicker?(): void;
  /** Apply and save a theme by name; false if there is no such theme. */
  setTheme?(name: string): boolean;
  themeName?: string;
  /** Open the pet adoption picker. */
  openPetPicker?(): void;
  /** The current pet, if any. */
  pet?: { kind: string; name: string; clicks: boolean };
  updatePet?(patch: { kind?: string; name?: string; clicks?: boolean }): void;
  pokePet?(): void;
  /** Summarize older turns now (/compact). */
  compact?(focus?: string): Promise<void>;
  /** A turn is running. */
  busy?: boolean;
  /** Run the current (Ollama) model with this context length; undefined = server default. Returns a report. */
  setContextLength?(tokens: number | "auto" | undefined): Promise<{ text: string; tone?: "info" | "warn" }>;
  /** Score models on fixed tasks and print a table (/bench). */
  bench?(specs: string[]): Promise<void>;
  /** Work on a goal across turns (/goal). */
  runGoal?(goal: GoalOptions): Promise<void>;
  /** Repeating prompts (/loop). */
  loops?: {
    start(everyMs: number, prompt: string): string;
    stop(id: string): boolean;
    list(): Array<{ id: string; everyMs: number; prompt: string; runs: number }>;
  };
}

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  run(args: string, ctx: CommandContext): void | Promise<void>;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    description: "Show commands and keys",
    run(_a, ctx) {
      const cmds = COMMANDS.map((c) => `  /${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(24) + c.description).join("\n");
      ctx.print(
        `Commands:\n${cmds}\n\nKeys:\n  Enter submit · \\ then Enter for a new line · ↑/↓ history\n  Esc or Ctrl+C interrupt · Shift+Tab cycle permission mode (plan mode: read-only, then approve a plan) · Ctrl+T show/hide tasks · Ctrl+C twice (idle) exit`,
      );
    },
  },
  {
    name: "clear",
    description: "Start a new conversation",
    run(_a, ctx) {
      ctx.agent.reset();
      ctx.startNewSession();
      ctx.clearTranscript();
      ctx.print("Started a new conversation.");
    },
  },
  {
    name: "resume",
    description: "Resume a previous conversation",
    run(_a, ctx) {
      ctx.openResume();
    },
  },
  {
    name: "mode",
    args: "[mode]",
    description: "Show or set the permission mode",
    run(args, ctx) {
      const m = args.trim();
      if (!m) return ctx.print(`Permission mode: ${ctx.agent.permissions.mode}`);
      if (!PERMISSION_MODES.includes(m as PermissionMode)) {
        return ctx.print(`Unknown mode "${m}". Modes: ${PERMISSION_MODES.join(", ")}`, "error");
      }
      if (m === "bypass" && !ctx.allowBypass) {
        return ctx.print("bypass can only be enabled at startup with --permission-mode bypass", "warn");
      }
      ctx.setMode(m as PermissionMode);
    },
  },
  {
    name: "model",
    args: "[provider:model]",
    description: "Pick a model from a list, or switch to one directly",
    async run(args, ctx) {
      const spec = args.trim();
      if (!spec) {
        if (ctx.openModelPicker) return ctx.openModelPicker();
        return ctx.print(`Model: ${ctx.agent.modelSpec}\nSwitch with /model <provider:model>, e.g. /model anthropic:claude-opus-5-5`);
      }
      await switchTo(spec, ctx);
    },
  },
  {
    name: "models",
    description: "Pick a model from a list",
    run(_a, ctx) {
      if (ctx.openModelPicker) return ctx.openModelPicker();
      ctx.print(`Model: ${ctx.agent.modelSpec}`);
    },
  },
  {
    name: "theme",
    args: "[name]",
    description: "Pick a colour theme, or set one by name",
    run(args, ctx) {
      const name = args.trim();
      if (!name) {
        if (ctx.openThemePicker) return ctx.openThemePicker();
        return ctx.print(`Theme: ${ctx.themeName ?? "forge"}`);
      }
      if (!ctx.setTheme) return ctx.print("Themes are not available here.", "warn");
      if (!ctx.setTheme(name)) {
        ctx.print(`No theme "${name}". Themes: ${THEMES.map((t) => t.name).join(", ")}`, "error");
        return;
      }
      const t = THEMES.find((x) => x.name === name.toLowerCase())!;
      ctx.print(`${t.icon} Theme set to ${t.label}.`);
    },
  },
  {
    name: "themes",
    description: "Browse colour themes with a live preview",
    run(_a, ctx) {
      if (ctx.openThemePicker) return ctx.openThemePicker();
      ctx.print(`Themes: ${THEMES.map((t) => t.name).join(", ")}`);
    },
  },
  {
    name: "pets",
    description: "Adopt a desk pet that lives above the prompt",
    run(_a, ctx) {
      if (ctx.openPetPicker) return ctx.openPetPicker();
      ctx.print("Pets are only available in the interactive UI.", "warn");
    },
  },
  {
    name: "pet",
    args: "[name <n> | clicks on|off | hide]",
    description: "Pet your pet, rename it, or toggle mouse clicks",
    run(args, ctx) {
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (!ctx.pet) {
        if (ctx.openPetPicker) return ctx.openPetPicker();
        return ctx.print("No pet yet. Try /pets.");
      }
      switch ((sub ?? "").toLowerCase()) {
        case "":
          ctx.pokePet?.();
          return;
        case "name": {
          const name = rest.join(" ").trim().slice(0, 20);
          if (!name) return ctx.print("Usage: /pet name <name>", "error");
          ctx.updatePet?.({ name });
          return ctx.print(`Your ${ctx.pet.kind.toLowerCase()} is now called ${name}.`);
        }
        case "clicks": {
          const v = (rest[0] ?? "").toLowerCase();
          if (v !== "on" && v !== "off") return ctx.print("Usage: /pet clicks on|off", "error");
          ctx.updatePet?.({ clicks: v === "on" });
          return ctx.print(
            v === "on"
              ? "Mouse clicks on: click your pet! While this is on the terminal sends mouse actions to Forge, so hold Shift to select/copy text (Shift+drag) or to scroll with the wheel. /pet clicks off turns it back off."
              : "Mouse clicks off: selecting, copying and scrolling work normally again. Press Ctrl+P (or /pet) to pet.",
          );
        }
        case "hide":
          ctx.updatePet?.({ kind: "none" });
          return ctx.print("Pet hidden. /pets to adopt one again.");
        default:
          return ctx.print("Usage: /pet [name <name> | clicks on|off | hide]", "error");
      }
    },
  },
  {
    name: "compact",
    args: "[focus]",
    description: "Summarize older turns to free up context",
    async run(args, ctx) {
      if (ctx.busy) return ctx.print("Wait for the current turn to finish (or press Esc), then /compact.", "warn");
      if (!ctx.compact) return ctx.print("Compaction is not available here.", "warn");
      await ctx.compact(args.trim() || undefined);
    },
  },
  {
    name: "context",
    args: "[size | auto | default]",
    description: "Show what fills the context window, or set its size (/context 32k, or auto to fit the GPU)",
    async run(args, ctx) {
      const a = args.trim().toLowerCase();
      if (!a) return ctx.print(formatContext(contextBreakdown(ctx.agent, ctx.memory)));
      if (ctx.busy) return ctx.print("Wait for the current turn to finish, then change the context size.", "warn");
      if (!ctx.setContextLength) return ctx.print("Changing the context size isn't available here.", "warn");
      let tokens: number | "auto" | undefined;
      if (a === "auto") tokens = "auto";
      else if (!["default", "reset"].includes(a)) {
        tokens = parseContextSize(a);
        if (tokens === undefined) return ctx.print('Usage: /context [size | auto | default], e.g. /context 32k or /context 24576', "error");
      }
      ctx.print(
        tokens === "auto"
          ? "Finding the largest context that fits in GPU memory…"
          : tokens
            ? `Setting the context to ${Math.round(tokens / 1024)}k and loading the model…`
            : "Going back to Ollama's default context and loading the model…",
      );
      try {
        const r = await ctx.setContextLength(tokens);
        ctx.print(r.text, r.tone);
      } catch (err) {
        ctx.print(err instanceof Error ? err.message : String(err), "error");
      }
    },
  },
  {
    name: "bench",
    args: "[models…]",
    description: "Score models on 5 fixed coding tasks (default: installed Ollama models)",
    async run(args, ctx) {
      if (ctx.busy) return ctx.print("Wait for the current turn to finish first.", "warn");
      if (!ctx.bench) return ctx.print("Benchmarking isn't available here; run forge --bench in a terminal.", "warn");
      const specs = args.split(/\s+/).filter(Boolean);
      ctx.print(`Benchmarking ${specs.length ? specs.join(", ") : "the installed Ollama models"} on 5 tasks, each in a throwaway folder. This takes a few minutes; Esc stops it.`);
      await ctx.bench(specs);
    },
  },
  {
    name: "goal",
    args: '<objective> [--check "<cmd>"] [--max-rounds N]',
    description: "Keep working until the goal is met: the check passes, or the model verifies it's done",
    async run(args, ctx) {
      if (ctx.busy) return ctx.print("Wait for the current turn to finish first.", "warn");
      if (!ctx.runGoal) return ctx.print("Goals aren't available here.", "warn");
      const goal = parseGoalArgs(args);
      if (!goal) return ctx.print('Usage: /goal <objective> [--check "<cmd>"] [--max-rounds N], e.g. /goal make the tests pass --check "npm test"', "error");
      await ctx.runGoal(goal);
    },
  },
  {
    name: "loop",
    args: "<interval> <prompt> | stop [id]",
    description: "Run a prompt every interval (e.g. /loop 10m check the build); /loop lists, /loop stop ends",
    run(args, ctx) {
      if (!ctx.loops) return ctx.print("Loops aren't available here.", "warn");
      const a = args.trim();
      if (!a) {
        const l = ctx.loops.list();
        return ctx.print(l.length ? `Loops:\n${l.map((x) => `  ${x.id}  every ${formatInterval(x.everyMs)}  (${x.runs} run${x.runs === 1 ? "" : "s"})  ${x.prompt}`).join("\n")}` : "No loops. Start one with /loop 10m <prompt>.");
      }
      const [first, ...rest] = a.split(/\s+/);
      if (first === "stop") {
        const ids = rest.length ? rest : ctx.loops.list().map((x) => x.id);
        if (!ids.length) return ctx.print("No loops to stop.");
        const stopped = ids.filter((id) => ctx.loops!.stop(id));
        return ctx.print(stopped.length ? `Stopped ${stopped.join(", ")}.` : `No loop ${ids.join(", ")}.`, stopped.length ? "info" : "warn");
      }
      const every = parseInterval(first!);
      const prompt = rest.join(" ").trim();
      if (every === undefined || !prompt) return ctx.print("Usage: /loop <interval> <prompt>, e.g. /loop 10m check whether CI passed (interval: 30s, 10m, 2h; at least 10s)", "error");
      const id = ctx.loops.start(every, prompt);
      ctx.print(`Started ${id}: every ${formatInterval(every)}, "${prompt}". It runs now, then whenever Forge is idle at each interval. /loop stop ${id} ends it.`);
    },
  },
  {
    name: "budget",
    args: "[cost <usd> | tokens <n> | requests <n> | off]",
    description: "Show or set this session's limits (cost, tokens, model requests per prompt)",
    run(args, ctx) {
      const [what, value] = args.trim().toLowerCase().split(/\s+/);
      const b = { ...(ctx.agent.budget ?? {}) };
      if (!what) {
        const parts = [
          b.costUSD !== undefined ? `cost $${b.costUSD} (used ${formatCost(ctx.agent.costUSD)})` : undefined,
          b.tokens !== undefined ? `tokens ${formatTokens(b.tokens)} (used ${formatTokens(ctx.agent.usage.inputTokens + ctx.agent.usage.outputTokens)})` : undefined,
          b.requestsPerPrompt !== undefined ? `${b.requestsPerPrompt} model requests per prompt` : undefined,
        ].filter(Boolean);
        return ctx.print(parts.length ? `Budget: ${parts.join(" · ")}` : 'No budget set. /budget cost 2, /budget tokens 500k, /budget requests 30, or "budget" in settings.');
      }
      if (what === "off") {
        ctx.agent.setBudget(undefined);
        return ctx.print("Budget removed for this session.");
      }
      const n = value === undefined ? NaN : what === "tokens" ? (parseContextSize(value) ?? NaN) : Number(value);
      if (!Number.isFinite(n) || n <= 0 || !["cost", "tokens", "requests"].includes(what)) return ctx.print("Usage: /budget [cost <usd> | tokens <n> | requests <n> | off]", "error");
      if (what === "cost") b.costUSD = n;
      else if (what === "tokens") b.tokens = Math.round(n);
      else b.requestsPerPrompt = Math.round(n);
      ctx.agent.setBudget(b);
      ctx.print(`Budget set: ${what} ${what === "cost" ? `$${n}` : Math.round(n)} (this session).`);
    },
  },
  {
    name: "usage",
    args: "[project]",
    description: "Tokens and cost: this session, today, this week and month, by model and by day",
    run(args, ctx) {
      const projectOnly = args.trim() === "project";
      const h = readHistory(ctx.env, projectOnly ? { root: ctx.root } : {});
      const id = ctx.agent.recorder && "id" in ctx.agent.recorder ? String((ctx.agent.recorder as { id: unknown }).id) : undefined;
      const scope = projectOnly ? "this project" : "all projects (/usage project for just this one)";
      ctx.print(`Usage across ${scope}:\n\n${usageReport(h, id ? { session: { id, label: "This session" } } : {})}`);
    },
  },
  {
    name: "stats",
    args: "[project]",
    description: "Activity: sessions per day, tools, files, turns per prompt, hours you work",
    run(args, ctx) {
      const projectOnly = args.trim() === "project";
      ctx.print(statsReport(readHistory(ctx.env, projectOnly ? { root: ctx.root } : {})));
    },
  },
  {
    name: "agents",
    args: "[stop <id>]",
    description: "List subagent types and background agents; stop one",
    run(args, ctx) {
      const [verb, id] = args.trim().split(/\s+/);
      if (verb === "stop") {
        if (!id) return ctx.print("Usage: /agents stop <id>", "error");
        const stopped = ctx.agent.stopBackground(id);
        return ctx.print(stopped ? `Stopping ${id}.` : `No running background agent "${id}".`, stopped ? "info" : "warn");
      }
      const types = ctx.agent.agentTypes
        .map((t) => `  ${t.name.padEnd(12)}${t.description.length > 90 ? `${t.description.slice(0, 89)}…` : t.description}${t.source === "built-in" ? "" : `\n  ${"".padEnd(12)}(${t.source})`}`)
        .join("\n");
      const bg = ctx.agent.backgroundTasks;
      const now = Date.now();
      const bgText = bg.length
        ? `\n\nBackground jobs:\n${bg
            .map((t) => `  ${t.id.padEnd(10)}${t.status.padEnd(9)}${t.type}: ${t.description} (${Math.round((now - t.startedAt) / 1000)}s)${t.status === "running" && t.activity ? `\n  ${"".padEnd(19)}⎿ ${t.activity}` : ""}`)
            .join("\n")}`
        : "";
      ctx.print(`Subagent types (add your own in .forge/agents/*.md):\n${types}${bgText}`);
    },
  },
  {
    name: "todos",
    description: "Show the current task list",
    run(_a, ctx) {
      const t = ctx.agent.todos;
      ctx.print(t.length ? `Tasks:\n${formatTodos(t)}` : "No tasks yet. Forge keeps a task list for multi-step work.");
    },
  },
  {
    name: "permissions",
    description: "Show the permission mode, rules and hooks in effect",
    run(_a, ctx) {
      const d = ctx.agent.permissions.describe();
      const list = (label: string, rules: string[]) => (rules.length ? `\n${label}:\n${rules.map((r) => `  ${r}`).join("\n")}` : "");
      const hooks = ctx.agent.hooks?.list() ?? [];
      const hookText = hooks.length
        ? `\nHooks:\n${hooks.map((h) => `  ${h.event}${h.matcher ? `(${h.matcher})` : ""}: ${h.command}`).join("\n")}`
        : "";
      const none = !d.allow.length && !d.deny.length && !d.ask.length && !d.session.length && !hooks.length;
      ctx.print(
        `Permission mode: ${d.mode}${list("Deny", d.deny)}${list("Ask", d.ask)}${list("Allow", d.allow)}${list("Allowed this session", d.session)}${hookText}${
          none
            ? '\n\nNo rules or hooks yet. Add them to .forge/settings.json (project) or ~/.forge/settings.json, e.g.\n  { "permissions": { "allow": ["bash(npm test:*)"], "deny": ["read(.env)"] } }'
            : ""
        }\n\nDangerous commands (rm -rf /, git push --force, curl | sh…) always ask, whatever the rules or mode.`,
      );
    },
  },
  {
    name: "cost",
    description: "Show token usage and cost for this session",
    run(_a, ctx) {
      const u = ctx.agent.usage;
      const priced = priceFor(ctx.agent.modelSpec) !== undefined;
      ctx.print(
        `Cost: ${priced ? formatCost(ctx.agent.costUSD) : "unknown for this model"}\nTokens: ${formatTokens(u.inputTokens)} in (${formatTokens(
          u.cacheReadTokens ?? 0,
        )} cache read, ${formatTokens(u.cacheWriteTokens ?? 0)} cache write) · ${formatTokens(u.outputTokens)} out\nContext: ${formatTokens(
          ctx.agent.lastInputTokens,
        )} / ${formatTokens(ctx.agent.contextWindow)}`,
      );
    },
  },
  {
    name: "memory",
    description: "List the AGENTS.md / FORGE.md files in effect",
    run(_a, ctx) {
      ctx.print(
        ctx.memory.length
          ? `Memory files (general → specific):\n${ctx.memory.map((m) => `  ${m.path} (${m.scope}, ${m.content.length} chars)`).join("\n")}`
          : "No memory files. Add AGENTS.md or FORGE.md to the project (or ~/.forge/) to give Forge standing instructions.",
      );
    },
  },
  {
    name: "exit",
    description: "Quit",
    run(_a, ctx) {
      ctx.exit();
    },
  },
];

/** Switch models and report the result (shared by /model and the picker). */
export async function switchTo(spec: string, ctx: Pick<CommandContext, "agent" | "print" | "switchModel">): Promise<void> {
  if (!ctx.switchModel) return ctx.print("Model switching is not available here.", "warn");
  try {
    const r = await ctx.switchModel(spec);
    ctx.print(`Switched to ${ctx.agent.modelSpec}. The conversation continues on the new model.`);
    if (r && r.warning) ctx.print(r.warning, "warn");
  } catch (err) {
    ctx.print(err instanceof Error ? err.message : String(err), "error");
  }
}

/** "32k" → 32768, "24576" → 24576; undefined if it isn't a size. */
/** "30s", "10m", "2h" → milliseconds (at least 10 s). */
export function parseInterval(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)$/i.exec(s.trim());
  if (!m) return undefined;
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]!.toLowerCase() as "s" | "m" | "h"];
  return ms >= 10_000 ? ms : undefined;
}

export function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function parseContextSize(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(k)?$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Math.round(Number(m[1]) * (m[2] ? 1024 : 1));
  return n > 0 ? n : undefined;
}

/** Commands for the slash menu: name-prefix matches first, then names containing the text. */
export function matchCommands(prefix: string): SlashCommand[] {
  const p = prefix.replace(/^\//, "").split(/\s/)[0]!.toLowerCase();
  const starts = COMMANDS.filter((c) => c.name.startsWith(p));
  const contains = COMMANDS.filter((c) => !c.name.startsWith(p) && c.name.includes(p));
  return [...starts, ...contains];
}

/** Parse "/name args". Returns undefined when the text is not a command. */
export function parseCommand(text: string): { command?: SlashCommand; name: string; args: string } | undefined {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  const command = COMMANDS.find((c) => c.name === name) ?? (name === "quit" ? COMMANDS.find((c) => c.name === "exit") : undefined);
  return { command, name, args: m[2] ?? "" };
}
