import { existsSync } from "node:fs";
import path from "node:path";

export interface ShellInfo {
  kind: "bash" | "powershell";
  path: string;
}

let cached: ShellInfo | undefined;

/**
 * Pick the shell for the bash tool: bash on POSIX; on Windows, Git Bash if it
 * can be found (never WSL's System32\bash.exe), else Windows PowerShell.
 */
export function detectShell(env: NodeJS.ProcessEnv = process.env): ShellInfo {
  if (cached) return cached;
  if (process.platform !== "win32") {
    cached = { kind: "bash", path: existsSync("/bin/bash") ? "/bin/bash" : "sh" };
    return cached;
  }
  const candidates = [
    env.FORGE_GIT_BASH,
    env.ProgramFiles && path.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
    ...(env.PATH ?? "")
      .split(path.delimiter)
      .filter((d) => !/system32/i.test(d))
      .map((d) => path.join(d, "bash.exe")),
  ].filter((p): p is string => Boolean(p));
  const bash = candidates.find((p) => existsSync(p));
  cached = bash ? { kind: "bash", path: bash } : { kind: "powershell", path: "powershell.exe" };
  return cached;
}

export const CWD_MARKER = "__FORGE_CWD__";

/** Wrap a command so it reports the shell's final cwd and keeps its exit code. */
export function wrapCommand(shell: ShellInfo, command: string): string[] {
  if (shell.kind === "bash") {
    const script = `${command}\n__forge_ec=$?\nprintf '\\n${CWD_MARKER}%s\\n' "$(pwd -W 2>/dev/null || pwd)"\nexit $__forge_ec`;
    return ["-c", script];
  }
  const script = `${command}\n$__forge_ec = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\nWrite-Output "${CWD_MARKER}$((Get-Location).Path)"\nexit $__forge_ec`;
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/** Split the cwd marker off the output. */
export function extractCwd(output: string): { output: string; cwd?: string } {
  const i = output.lastIndexOf(CWD_MARKER);
  if (i === -1) return { output };
  const cwd = output.slice(i + CWD_MARKER.length).trim();
  return { output: output.slice(0, i).replace(/\r?\n$/, ""), cwd: cwd || undefined };
}
