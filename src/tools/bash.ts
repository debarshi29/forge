import { existsSync } from "node:fs";
import { execa } from "execa";
import { z } from "zod";
import { isInside } from "./paths.js";
import { detectShell, extractCwd, wrapCommand } from "./shell.js";
import { defineTool, ToolError, type ToolContext, type ToolResult } from "./types.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
/** Background commands may run much longer (dev servers, long test suites). */
const BACKGROUND_TIMEOUT = 3_600_000;
const MAX_OUTPUT = 30_000;

const shell = detectShell();

export const bashTool = defineTool({
  name: "bash",
  description: `Run a shell command (${shell.kind === "bash" ? "bash" : "Windows PowerShell"}) and return its combined stdout/stderr and exit code.
- The working directory persists between calls (cd carries over), but it must stay inside the project.
- Default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s (timeout_ms). Output over ${MAX_OUTPUT} characters is cut in the middle.
- Commands run non-interactively: never use commands that wait for input or open an editor (git rebase -i, vim, less).
- Prefer the read, glob, grep and ls tools over cat, find, grep and ls; use this for builds, tests, git, and package managers.
- Quote paths that contain spaces.
- run_in_background: true starts the command and returns at once; you get its output when it exits (up to 1 hour). Use it for long builds or test runs while you do other work, not for commands you need right away.`,
  schema: z.object({
    command: z.string().min(1).describe("The command to run"),
    timeout_ms: z.number().int().min(1000).max(BACKGROUND_TIMEOUT).optional(),
    description: z.string().optional().describe("Short description of what the command does, shown to the user"),
    run_in_background: z.boolean().optional().describe("Run without waiting; its output arrives when it exits"),
  }),
  readOnly: false,
  summarize: (i) => (i.run_in_background ? `${i.command} (background)` : i.command),
  async run(input, ctx) {
    if (!input.run_in_background) {
      if ((input.timeout_ms ?? 0) > MAX_TIMEOUT) throw new ToolError(`timeout_ms can be at most ${MAX_TIMEOUT} unless run_in_background is set`);
      return runCommand(input.command, ctx, ctx.signal, { timeout: input.timeout_ms ?? DEFAULT_TIMEOUT, followCwd: true });
    }
    if (!ctx.startBackground) throw new ToolError("Background commands aren't available here; run it without run_in_background.");
    const id = ctx.startBackground({
      kind: "bash",
      type: "bash",
      description: input.description ?? input.command,
      // A background command keeps its own directory; it doesn't move the shell.
      run: (signal, activity) => runCommand(input.command, ctx, signal, { timeout: input.timeout_ms ?? BACKGROUND_TIMEOUT, followCwd: false, onLine: activity }),
    });
    return { content: `Started ${id} in the background: ${input.command}\nYou'll get its output when it exits; carry on meanwhile.` };
  },
});

async function runCommand(
  command: string,
  ctx: ToolContext,
  signal: AbortSignal,
  opts: { timeout: number; followCwd: boolean; onLine?: (line: string) => void },
): Promise<ToolResult> {
  const cwd = existsSync(ctx.shell.cwd) ? ctx.shell.cwd : ctx.root;
  const child = execa(shell.path, wrapCommand(shell, command), {
    cwd,
    all: true,
    reject: false,
    stdin: "ignore",
    timeout: opts.timeout,
    cancelSignal: signal,
    forceKillAfterDelay: 2000,
    maxBuffer: 20_000_000,
    windowsHide: true,
    env: { FORGE: "1", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  if (opts.onLine) {
    child.all?.on("data", (chunk: Buffer) => {
      const last = chunk.toString().split(/\r?\n/).filter((l) => l.trim() && !l.includes("__FORGE_CWD__")).at(-1);
      if (last) opts.onLine!(last.slice(0, 200));
    });
  }
  const r = await child;
  const { output, cwd: newCwd } = extractCwd(String(r.all ?? ""));
  let note = "";
  if (newCwd && opts.followCwd) {
    if (isInside(ctx.root, newCwd)) ctx.shell.cwd = newCwd;
    else note = `\n[cwd ${newCwd} is outside the project; staying in ${ctx.shell.cwd}]`;
  }
  let text = output;
  if (text.length > MAX_OUTPUT) {
    const half = MAX_OUTPUT / 2;
    text = `${text.slice(0, half)}\n\n[… ${text.length - MAX_OUTPUT} characters cut …]\n\n${text.slice(-half)}`;
  }
  if (r.timedOut) return { content: `${text}\n[timed out after ${opts.timeout / 1000}s]${note}`, isError: true };
  if (r.isCanceled) return { content: `${text}\n[interrupted]`, isError: true };
  const code = r.exitCode ?? -1;
  return {
    content: `${text || "(no output)"}${code === 0 ? "" : `\n[exit code ${code}]`}${note}`,
    isError: code !== 0,
  };
}
