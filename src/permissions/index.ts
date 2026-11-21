import type { Tool } from "../tools/types.js";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];

export interface PermissionRequest {
  tool: string;
  input: unknown;
  /** One-line summary of the call, e.g. the bash command or file path. */
  summary: string;
}

export type AskAnswer = { kind: "yes" } | { kind: "always" } | { kind: "no"; reason?: string };
export type AskFn = (req: PermissionRequest) => Promise<AskAnswer>;

export type Decision = { allow: true } | { allow: false; reason: string };

const EDIT_TOOLS = new Set(["write", "edit"]);

/**
 * Milestone 1 permissions: read-only tools always run; otherwise the mode
 * decides, falling back to asking the user. Rules, hooks and the bash
 * deny-list arrive in Milestone 5.
 */
export class Permissions {
  private sessionAllow = new Set<string>();

  constructor(
    public mode: PermissionMode,
    private readonly ask?: AskFn,
  ) {}

  async check(tool: Tool, input: unknown): Promise<Decision> {
    if (tool.readOnly || this.mode === "bypass") return { allow: true };
    if (this.mode === "plan") {
      return { allow: false, reason: "Plan mode is on: only read-only tools may run. Present your plan instead." };
    }
    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(tool.name)) return { allow: true };

    const summary = tool.summarize?.(input as never) ?? JSON.stringify(input);
    const key = sessionKey(tool.name, summary);
    if (this.sessionAllow.has(key)) return { allow: true };
    if (!this.ask) {
      return {
        allow: false,
        reason: `${tool.name} needs permission, and no one is available to approve it (non-interactive run). The user can rerun with --permission-mode acceptEdits or bypass.`,
      };
    }
    const answer = await this.ask({ tool: tool.name, input, summary });
    if (answer.kind === "always") this.sessionAllow.add(key);
    if (answer.kind === "no") {
      return { allow: false, reason: answer.reason ? `The user denied this: ${answer.reason}` : "The user denied this tool call." };
    }
    return { allow: true };
  }
}

/** "Always" for bash approves that exact command; for other tools, the tool. */
function sessionKey(tool: string, summary: string): string {
  return tool === "bash" ? `bash:${summary}` : tool;
}
