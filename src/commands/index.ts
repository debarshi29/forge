import type { Agent } from "../agent/loop.js";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/index.js";
import { formatTokens } from "../ui/format.js";

export interface CommandContext {
  agent: Agent;
  print(text: string, tone?: "info" | "warn" | "error"): void;
  clearTranscript(): void;
  setMode(mode: PermissionMode): void;
  exit(): void;
  allowBypass: boolean;
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
      ctx.clearTranscript();
      ctx.print("Started a new conversation.");
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
    description: "Show the current model",
    run(_a, ctx) {
      ctx.print(`Model: ${ctx.agent.model} (switching arrives with multi-provider support)`);
    },
  },
  {
    name: "cost",
    description: "Show token usage for this session",
    run(_a, ctx) {
      const u = ctx.agent.usage;
      ctx.print(
        `Tokens: ${formatTokens(u.inputTokens)} in (${formatTokens(u.cacheReadTokens ?? 0)} cache read, ${formatTokens(
          u.cacheWriteTokens ?? 0,
        )} cache write) · ${formatTokens(u.outputTokens)} out\nContext: ${formatTokens(ctx.agent.lastInputTokens)} / ${formatTokens(
          ctx.agent.contextWindow,
        )}`,
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
