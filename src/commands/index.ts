import type { Agent } from "../agent/loop.js";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/index.js";
import { formatCost, priceFor } from "../agent/cost.js";
import type { MemoryFile } from "../agent/memory.js";
import { formatTokens } from "../ui/format.js";

export interface CommandContext {
  agent: Agent;
  print(text: string, tone?: "info" | "warn" | "error"): void;
  clearTranscript(): void;
  /** Point persistence at a fresh session file (no-op when sessions are off). */
  startNewSession(): void;
  openResume(): void;
  setMode(mode: PermissionMode): void;
  exit(): void;
  allowBypass: boolean;
  memory: MemoryFile[];
  /** Resolve a "provider:model" spec and switch the agent to it; throws on bad specs. */
  switchModel?(spec: string): void;
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
        `Commands:\n${cmds}\n\nKeys:\n  Enter submit · \\ then Enter for a new line · ↑/↓ history\n  Esc or Ctrl+C interrupt · Shift+Tab cycle permission mode · Ctrl+C twice (idle) exit`,
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
    description: "Show or switch the model",
    run(args, ctx) {
      const spec = args.trim();
      if (!spec) {
        return ctx.print(
          `Model: ${ctx.agent.modelSpec}\nSwitch with /model <provider:model>, e.g.\n  /model anthropic:claude-opus-5-5\n  /model anthropic:claude-sonnet-5-5\n  /model gemini:gemini-2.5-pro\n  /model openai:gpt-5\n  /model ollama:qwen3-coder`,
        );
      }
      if (!ctx.switchModel) return ctx.print("Model switching is not available here.", "warn");
      try {
        ctx.switchModel(spec);
        ctx.print(`Switched to ${ctx.agent.modelSpec}. The conversation continues on the new model.`);
      } catch (err) {
        ctx.print(err instanceof Error ? err.message : String(err), "error");
      }
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

export function matchCommands(prefix: string): SlashCommand[] {
  const p = prefix.replace(/^\//, "").split(/\s/)[0]!.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(p));
}

/** Parse "/name args". Returns undefined when the text is not a command. */
export function parseCommand(text: string): { command?: SlashCommand; name: string; args: string } | undefined {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return undefined;
  const name = m[1]!.toLowerCase();
  const command = COMMANDS.find((c) => c.name === name) ?? (name === "quit" ? COMMANDS.find((c) => c.name === "exit") : undefined);
  return { command, name, args: m[2] ?? "" };
}
