import type { Tool } from "../tools/types.js";
import { dangerReason } from "./danger.js";
import { hasShellTricks, parseRules, ruleMatches, splitCommand, type ParsedRules, type Rule, type RuleSet } from "./rules.js";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];

export type { RuleSet } from "./rules.js";

export interface PermissionRequest {
  tool: string;
  input: unknown;
  /** One-line summary of the call, e.g. the bash command or file path. */
  summary: string;
  /** "plan" asks the user to approve a plan (exit_plan_mode) instead of a tool call. */
  kind?: "tool" | "plan";
  /** Shown prominently: why this call is risky. */
  warning?: string;
  /** False hides "don't ask again" (dangerous commands). Default true. */
  allowAlways?: boolean;
}

/**
 * For tool calls: yes / yes and don't ask again / no.
 * For plans: "always" = approve and auto-accept edits, "yes" = approve and keep asking.
 */
export type AskAnswer = { kind: "yes" } | { kind: "always" } | { kind: "no"; reason?: string };
export type AskFn = (req: PermissionRequest) => Promise<AskAnswer>;

export type Decision = { allow: true } | { allow: false; reason: string };

export type PlanDecision = { approved: true; mode: PermissionMode } | { approved: false; feedback?: string; reason: string };

const EDIT_TOOLS = new Set(["write", "edit"]);

export interface PermissionsOptions {
  /** allow / deny / ask rules from settings. */
  rules?: RuleSet;
  /** Project root, for path rules. */
  root?: string;
}

/**
 * Order of checks for a tool call:
 *  1. deny rules            → refused (in every mode)
 *  2. dangerous bash        → always asks, with a warning (even in bypass)
 *  3. bypass mode           → allowed
 *  4. plan mode             → only read-only tools
 *  5. ask rules             → asks
 *  6. read-only tools       → allowed
 *  7. allow rules           → allowed
 *  8. acceptEdits + write/edit, or "don't ask again" this session → allowed
 *  9. otherwise             → asks
 */
export class Permissions {
  private sessionAllow = new Set<string>();
  private readonly rules: ParsedRules;
  private readonly root: string;
  private _mode: PermissionMode;
  private listeners = new Set<(mode: PermissionMode) => void>();

  constructor(
    mode: PermissionMode,
    private readonly ask?: AskFn,
    opts: PermissionsOptions = {},
  ) {
    this._mode = mode;
    this.rules = parseRules(opts.rules);
    this.root = opts.root ?? process.cwd();
  }

  get mode(): PermissionMode {
    return this._mode;
  }

  set mode(m: PermissionMode) {
    if (m === this._mode) return;
    this._mode = m;
    for (const l of this.listeners) l(m);
  }

  /** Be told when the mode changes (Shift+Tab, /mode, or an approved plan). */
  onModeChange(fn: (mode: PermissionMode) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get interactive(): boolean {
    return this.ask !== undefined;
  }

  /** Rules in effect, for /permissions. */
  describe(): { mode: PermissionMode; allow: string[]; deny: string[]; ask: string[]; session: string[] } {
    const raw = (r: Rule[]) => r.map((x) => x.raw);
    return {
      mode: this._mode,
      allow: raw(this.rules.allow),
      deny: raw(this.rules.deny),
      ask: raw(this.rules.ask),
      session: [...this.sessionAllow].map((k) => (k.startsWith("bash:") ? `bash(${k.slice(5)})` : k)),
    };
  }

  async check(tool: Tool, input: unknown): Promise<Decision> {
    const summary = safeSummary(tool, input);
    const ctx = { root: this.root, summary };
    const command = tool.name === "bash" ? String((input as { command?: unknown })?.command ?? "") : undefined;
    const segments = command !== undefined ? splitCommand(command) : undefined;

    // 1. Deny rules win everywhere. For bash, any piece of a compound command counts.
    const denied = this.firstMatch(this.rules.deny, tool.name, input, ctx, segments, "any");
    if (denied) {
      return { allow: false, reason: `Blocked by the permission rule "${denied.raw}" in settings. Don't retry this; find another way or ask the user.` };
    }

    // 2. Dangerous commands always need a human.
    const danger = command !== undefined ? dangerReason(command) : undefined;
    if (danger) {
      if (!this.ask) {
        return { allow: false, reason: `Refused: this command ${danger}, and there is no one to approve it in a non-interactive run.` };
      }
      return this.askUser(tool.name, input, summary, { warning: `This command ${danger}.`, allowAlways: false });
    }

    if (this._mode === "bypass") return { allow: true };
    if (this._mode === "plan" && !tool.readOnly) {
      return {
        allow: false,
        reason: "Plan mode is on: only read-only tools may run. Finish investigating, then call exit_plan_mode with your plan.",
      };
    }

    const mustAsk = this.firstMatch(this.rules.ask, tool.name, input, ctx, segments, "any");
    if (!mustAsk) {
      if (tool.readOnly) return { allow: true };
      if (this.firstMatch(this.rules.allow, tool.name, input, ctx, segments, "all", command)) return { allow: true };
      if (this._mode === "acceptEdits" && EDIT_TOOLS.has(tool.name)) return { allow: true };
      if (this.sessionAllow.has(sessionKey(tool.name, summary))) return { allow: true };
    }

    if (!this.ask) {
      return {
        allow: false,
        reason: `${tool.name} needs permission, and no one is available to approve it (non-interactive run). The user can add an allow rule in .forge/settings.json or rerun with --permission-mode acceptEdits or bypass.`,
      };
    }
    return this.askUser(tool.name, input, summary, mustAsk ? { warning: `Settings ask to confirm "${mustAsk.raw}".` } : {});
  }

  /** Show a plan to the user (exit_plan_mode). Switches mode on approval. */
  async approvePlan(plan: string): Promise<PlanDecision> {
    if (this._mode !== "plan") {
      return { approved: false, reason: "Plan mode is not on, so there is nothing to exit. Go ahead with the task." };
    }
    if (!this.ask) {
      return {
        approved: false,
        reason: "This is a non-interactive run, so no one can approve the plan. Stop here: present the plan as your final answer.",
      };
    }
    const answer = await this.ask({ tool: "exit_plan_mode", input: { plan }, summary: plan, kind: "plan" });
    if (answer.kind === "no") {
      return {
        approved: false,
        ...(answer.reason ? { feedback: answer.reason } : {}),
        reason: answer.reason
          ? `The user wants changes to the plan: ${answer.reason}\nStay in plan mode, revise the plan, and call exit_plan_mode again.`
          : "The user rejected the plan. Stay in plan mode and ask what they would like to change.",
      };
    }
    const mode: PermissionMode = answer.kind === "always" ? "acceptEdits" : "default";
    this.mode = mode;
    return { approved: true, mode };
  }

  private async askUser(tool: string, input: unknown, summary: string, extra: Partial<PermissionRequest>): Promise<Decision> {
    const answer = await this.ask!({ tool, input, summary, kind: "tool", ...extra });
    if (answer.kind === "always" && extra.allowAlways !== false) this.sessionAllow.add(sessionKey(tool, summary));
    if (answer.kind === "no") {
      return { allow: false, reason: answer.reason ? `The user denied this: ${answer.reason}` : "The user denied this tool call." };
    }
    return { allow: true };
  }

  /**
   * For bash, "any" matches if the whole command or any piece matches (deny/ask);
   * "all" needs every piece to match some rule and no substitution or
   * redirection tricks (allow).
   */
  private firstMatch(
    rules: Rule[],
    tool: string,
    input: unknown,
    ctx: { root: string; summary: string },
    segments: string[] | undefined,
    how: "any" | "all",
    command?: string,
  ): Rule | undefined {
    if (!rules.length) return undefined;
    const one = (inp: unknown) => rules.find((r) => ruleMatches(r, tool, inp, ctx));
    if (!segments) return one(input);
    if (how === "any") {
      return one(input) ?? segments.map((s) => one({ command: s })).find(Boolean);
    }
    // A bare `bash` rule (no pattern) allows everything, tricks included.
    const bare = rules.find((r) => (r.tool === "bash" || r.tool === "*") && r.pattern === undefined);
    if (bare) return bare;
    if (command === undefined || hasShellTricks(command) || segments.length === 0) return undefined;
    const matched = segments.map((s) => one({ command: s }));
    return matched.every(Boolean) ? matched[0] : undefined;
  }
}

function safeSummary(tool: Tool, input: unknown): string {
  try {
    return tool.summarize?.(input as never) ?? JSON.stringify(input);
  } catch {
    return JSON.stringify(input);
  }
}

/** "Always" for bash approves that exact command; for other tools, the tool. */
function sessionKey(tool: string, summary: string): string {
  return tool === "bash" ? `bash:${summary}` : tool;
}
