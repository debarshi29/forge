import { existsSync } from "node:fs";
import { execa } from "execa";
import { z } from "zod";
import { isInside } from "./paths.js";
import { detectShell, extractCwd, wrapCommand } from "./shell.js";
import { defineTool } from "./types.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

const shell = detectShell();

export const bashTool = defineTool({
  name: "bash",
  description: `Run a shell command (${shell.kind === "bash" ? "bash" : "Windows PowerShell"}) and return its combined stdout/stderr and exit code.
- The working directory persists between calls (cd carries over), but it must stay inside the project.
- Default timeout ${DEFAULT_TIMEOUT / 1000}s, max ${MAX_TIMEOUT / 1000}s (timeout_ms). Output over ${MAX_OUTPUT} characters is cut in the middle.
- Commands run non-interactively: never use commands that wait for input or open an editor (git rebase -i, vim, less).
- Prefer the read, glob, grep and ls tools over cat, find, grep and ls; use this for builds, tests, git, and package managers.
- Quote paths that contain spaces.`,
  schema: z.object({
    command: z.string().min(1).describe("The command to run"),
    timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT).optional(),
    description: z.string().optional().describe("Short description of what the command does, shown to the user"),
  }),
  readOnly: false,
  summarize: (i) => i.command,
  async run(input, ctx) {
    const cwd = existsSync(ctx.shell.cwd) ? ctx.shell.cwd : ctx.root;
    const r = await execa(shell.path, wrapCommand(shell, input.command), {
      cwd,
      all: true,
      reject: false,
      stdin: "ignore",
      timeout: input.timeout_ms ?? DEFAULT_TIMEOUT,
      cancelSignal: ctx.signal,
      forceKillAfterDelay: 2000,
      maxBuffer: 20_000_000,
      windowsHide: true,
      env: { FORGE: "1", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
    });
    const { output, cwd: newCwd } = extractCwd(String(r.all ?? ""));
    let note = "";
    if (newCwd) {
      if (isInside(ctx.root, newCwd)) ctx.shell.cwd = newCwd;
      else note = `\n[cwd ${newCwd} is outside the project; staying in ${ctx.shell.cwd}]`;
    }
    let text = output;
    if (text.length > MAX_OUTPUT) {
      const half = MAX_OUTPUT / 2;
      text = `${text.slice(0, half)}\n\n[… ${text.length - MAX_OUTPUT} characters cut …]\n\n${text.slice(-half)}`;
    }
    if (r.timedOut) {
      return { content: `${text}\n[timed out after ${(input.timeout_ms ?? DEFAULT_TIMEOUT) / 1000}s]${note}`, isError: true };
    }
    if (r.isCanceled) return { content: `${text}\n[interrupted by user]`, isError: true };
    const code = r.exitCode ?? -1;
    return {
      content: `${text || "(no output)"}${code === 0 ? "" : `\n[exit code ${code}]`}${note}`,
      isError: code !== 0,
    };
  },
});
