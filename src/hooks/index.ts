import { execa } from "execa";
import { detectShell, type ShellInfo } from "../tools/shell.js";

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookSpec {
  /** Regex on the tool name (tool events only); empty or "*" matches every tool. */
  matcher?: string;
  /** Shell command; receives the event as JSON on stdin. */
  command: string;
  /** Seconds before the hook is killed (default 60). */
  timeout?: number;
}

export type HooksConfig = Partial<Record<HookEvent, HookSpec[]>>;

export interface HookPayload {
  hook_event_name: HookEvent;
  cwd: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: { content: string; is_error: boolean };
  prompt?: string;
  stop_hook_active?: boolean;
}

export interface HookOutcome {
  /** Set when a hook blocked: exit code 2, or {"decision":"block"} on stdout. */
  block?: string;
  /** PreToolUse: replacement tool input from {"updatedInput": {...}}. */
  updatedInput?: unknown;
  /** Text for the model: UserPromptSubmit stdout, or {"additionalContext": "..."}. */
  context: string[];
  /** Problems to show the user (failed or timed-out hooks); never block. */
  warnings: string[];
}

const DEFAULT_TIMEOUT_S = 60;

/**
 * User-configured shell commands around the agent loop. Exit 0 = carry on;
 * exit 2 = block, with stderr fed back (to the model for tool and Stop
 * events, to the user for UserPromptSubmit); any other exit is a non-blocking
 * error shown to the user. Stdout may be JSON:
 * {"decision": "block", "reason": "..."}, {"updatedInput": {...}} (PreToolUse),
 * {"additionalContext": "..."}.
 */
export class Hooks {
  private readonly shell: ShellInfo;
  private readonly compiled: Array<{ event: HookEvent; spec: HookSpec; re?: RegExp }> = [];

  constructor(
    config: HooksConfig = {},
    private readonly root: string,
    shell?: ShellInfo,
  ) {
    this.shell = shell ?? detectShell();
    for (const event of HOOK_EVENTS) {
      for (const spec of config[event] ?? []) {
        const m = spec.matcher?.trim();
        let re: RegExp | undefined;
        if (m && m !== "*") {
          try {
            re = new RegExp(`^(?:${m})$`, "i");
          } catch (err) {
            throw new Error(`Invalid ${event} hook matcher "${m}": ${(err as Error).message}`);
          }
        }
        this.compiled.push({ event, spec, ...(re ? { re } : {}) });
      }
    }
  }

  get count(): number {
    return this.compiled.length;
  }

  list(): Array<{ event: HookEvent; matcher?: string; command: string }> {
    return this.compiled.map((c) => ({ event: c.event, ...(c.spec.matcher ? { matcher: c.spec.matcher } : {}), command: c.spec.command }));
  }

  has(event: HookEvent, tool?: string): boolean {
    return this.matching(event, tool).length > 0;
  }

  /** Run every hook for the event (in order; the first block stops the rest). */
  async run(payload: HookPayload, signal?: AbortSignal): Promise<HookOutcome> {
    const out: HookOutcome = { context: [], warnings: [] };
    let current = payload;
    for (const h of this.matching(payload.hook_event_name, payload.tool_name)) {
      const r = await this.exec(h.spec, current, signal);
      out.warnings.push(...r.warnings);
      out.context.push(...r.context);
      if (r.updatedInput !== undefined) {
        out.updatedInput = r.updatedInput;
        current = { ...current, tool_input: r.updatedInput };
      }
      if (r.block !== undefined) {
        out.block = r.block;
        break;
      }
    }
    return out;
  }

  private matching(event: HookEvent, tool?: string) {
    return this.compiled.filter((c) => c.event === event && (!c.re || (tool !== undefined && c.re.test(tool))));
  }

  private async exec(spec: HookSpec, payload: HookPayload, signal?: AbortSignal): Promise<HookOutcome> {
    const out: HookOutcome = { context: [], warnings: [] };
    const args = this.shell.kind === "bash" ? ["-c", spec.command] : ["-NoProfile", "-NonInteractive", "-Command", spec.command];
    const timeout = (spec.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
    const r = await execa(this.shell.path, args, {
      cwd: this.root,
      input: JSON.stringify(payload),
      reject: false,
      timeout,
      ...(signal ? { cancelSignal: signal } : {}),
      forceKillAfterDelay: 2000,
      windowsHide: true,
      env: { FORGE_PROJECT_DIR: this.root, FORGE_HOOK_EVENT: payload.hook_event_name },
    });
    const stdout = String(r.stdout ?? "").trim();
    const stderr = String(r.stderr ?? "").trim();
    const label = `${payload.hook_event_name} hook \`${short(spec.command)}\``;

    if (r.isCanceled) return out;
    if (r.timedOut) {
      out.warnings.push(`${label} timed out after ${timeout / 1000}s`);
      return out;
    }
    if (r.exitCode === 2) {
      out.block = stderr || stdout || `Blocked by ${label}.`;
      return out;
    }
    if (r.exitCode !== 0) {
      out.warnings.push(`${label} failed (exit ${r.exitCode ?? "?"})${stderr ? `: ${short(stderr, 300)}` : ""}`);
      return out;
    }

    const json = parseJson(stdout);
    if (json) {
      if (json.decision === "block") out.block = typeof json.reason === "string" && json.reason ? json.reason : `Blocked by ${label}.`;
      if (json.updatedInput !== undefined && payload.hook_event_name === "PreToolUse") out.updatedInput = json.updatedInput;
      if (typeof json.additionalContext === "string" && json.additionalContext.trim()) out.context.push(json.additionalContext.trim());
    } else if (stdout && payload.hook_event_name === "UserPromptSubmit") {
      out.context.push(stdout);
    }
    return out;
  }
}

function parseJson(s: string): Record<string, unknown> | undefined {
  if (!s.startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function short(s: string, max = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
