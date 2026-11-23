import { execa } from "execa";
import { detectShell, type ShellInfo } from "../tools/shell.js";

/** What a status line command gets on stdin. */
export interface StatusState {
  session_id?: string;
  cwd: string;
  model: string;
  permission_mode: string;
  context: { tokens: number; window: number; percent: number };
  cost_usd: number;
  tokens: { input: number; output: number };
}

/**
 * Make a status line renderer from settings: runs the command in the shell
 * with the state as JSON on stdin and returns its first two lines of stdout.
 */
export function makeStatusLine(spec: { command: string; timeout?: number }, root: string, shell: ShellInfo = detectShell()) {
  return async (state: StatusState): Promise<string> => {
    const args = shell.kind === "bash" ? ["-c", spec.command] : ["-NoProfile", "-NonInteractive", "-Command", spec.command];
    const r = await execa(shell.path, args, {
      cwd: root,
      input: JSON.stringify(state),
      reject: false,
      timeout: (spec.timeout ?? 5) * 1000,
      env: { FORGE_PROJECT_DIR: root },
    });
    if (r.timedOut) return "status line: timed out";
    if (r.exitCode !== 0) return `status line failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).split("\n")[0] ?? ""}`;
    return r.stdout.replace(/\s+$/, "").split(/\r?\n/).slice(0, 2).join("\n");
  };
}
