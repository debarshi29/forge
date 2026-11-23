import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { detectShell, type ShellInfo } from "../tools/shell.js";

export interface DiagnosticsOptions {
  /**
   * A shell command to run instead of the built-in checks. "{files}" becomes
   * the changed files (quoted, relative to the project). Non-zero exit = problems.
   */
  command?: string;
  /** Seconds before a check is abandoned (default 60). */
  timeout?: number;
}

export interface DiagnosticsReport {
  /** Text for the model (empty when everything is clean). */
  text: string;
  /** Number of problems found (approximate for free-form output). */
  count: number;
  /** Which checks ran, for display ("tsc", "node --check", ...). */
  checks: string[];
}

const MAX_LINES = 30;

/**
 * Check files the agent just changed: the project's TypeScript compiler,
 * Node's syntax check, Python's compiler and JSON parsing, or a configured
 * command. Problems only in other files are left out, so the model sees what
 * its edit broke.
 */
export async function runDiagnostics(
  root: string,
  files: string[],
  opts: DiagnosticsOptions = {},
  signal?: AbortSignal,
  shell: ShellInfo = detectShell(),
): Promise<DiagnosticsReport> {
  const rel = [...new Set(files)].map((f) => toRel(root, f)).filter((f) => !f.startsWith("../") && existsSync(path.join(root, f)));
  const timeout = (opts.timeout ?? 60) * 1000;
  const out: DiagnosticsReport = { text: "", count: 0, checks: [] };
  if (!rel.length) return out;
  const sections: string[] = [];
  const add = (check: string, lines: string[]) => {
    out.checks.push(check);
    if (!lines.length) return;
    // One problem per line that points at a location ("a.ts(3,5)", "b.js:12", "line 4"); at least one.
    out.count += Math.max(1, lines.filter((l) => /\(\d+,\d+\)|:\d+\b|\bline \d+/.test(l)).length);
    const shown = lines.slice(0, MAX_LINES);
    sections.push(`${check}:\n${shown.join("\n")}${lines.length > shown.length ? `\n… and ${lines.length - shown.length} more` : ""}`);
  };

  if (opts.command) {
    const cmd = opts.command.replace(/\{files\}/g, rel.map((f) => JSON.stringify(f)).join(" "));
    const args = shell.kind === "bash" ? ["-c", cmd] : ["-NoProfile", "-NonInteractive", "-Command", cmd];
    const r = await execa(shell.path, args, { cwd: root, reject: false, timeout, all: true, cancelSignal: signal, env: { FORCE_COLOR: "0", NO_COLOR: "1" } });
    const lines = r.exitCode === 0 || r.isCanceled ? [] : nonEmpty(stripAnsi(r.all ?? ""));
    if (r.timedOut) lines.splice(0, lines.length, `(the check timed out after ${opts.timeout ?? 60}s)`);
    add(opts.command, lines.length ? lines : r.exitCode === 0 ? [] : [`exited with code ${r.exitCode}`]);
    out.text = sections.join("\n\n");
    return out;
  }

  const ts = rel.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"));
  const js = rel.filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const py = rel.filter((f) => f.endsWith(".py"));
  const json = rel.filter((f) => f.endsWith(".json") && !/(^|\/)(tsconfig[^/]*|jsconfig|\.vscode\/[^/]+|devcontainer)\.json$/.test(f));

  const tsc = findTsc(root);
  if (tsc && (ts.length || (js.length && usesCheckJs(root)))) {
    const r = await execa(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", root], { cwd: root, reject: false, timeout, all: true, cancelSignal: signal });
    if (!r.timedOut && !r.isCanceled) {
      const wanted = new Set([...ts, ...js].map((f) => f.toLowerCase()));
      // tsc prints "src/a.ts(3,5): error TS2322: ..." (plus continuation lines).
      const lines: string[] = [];
      let keep = false;
      for (const line of nonEmpty(r.all ?? "")) {
        const m = /^(.+?)\(\d+,\d+\): (error|warning)/.exec(line);
        if (m) keep = wanted.has(toRel(root, path.resolve(root, m[1]!)).toLowerCase());
        if (keep) lines.push(line);
      }
      add("tsc --noEmit", lines);
    }
  }
  for (const f of js.filter(() => !tsc || !usesCheckJs(root))) {
    const r = await execa(process.execPath, ["--check", f], { cwd: root, reject: false, timeout, all: true, cancelSignal: signal });
    if (r.exitCode !== 0 && !r.timedOut && !r.isCanceled) add(`node --check ${f}`, nonEmpty(r.all ?? "").filter((l) => !/^\s+at |^Node\.js v/.test(l)).slice(0, 8));
    else out.checks.push(`node --check ${f}`);
  }
  if (py.length) {
    const python = await findPython(root);
    if (python) {
      const r = await execa(python, ["-m", "py_compile", ...py], { cwd: root, reject: false, timeout, all: true, cancelSignal: signal });
      add("python -m py_compile", r.exitCode === 0 || r.isCanceled ? [] : nonEmpty(r.all ?? ""));
    }
  }
  for (const f of json) {
    try {
      JSON.parse(readFileSync(path.join(root, f), "utf8"));
      out.checks.push(`JSON ${f}`);
    } catch (err) {
      add(`JSON ${f}`, [`${f}: ${(err as Error).message}`]);
    }
  }
  out.text = sections.join("\n\n");
  return out;
}

/** The project's own TypeScript compiler, when it has a tsconfig. */
function findTsc(root: string): string | undefined {
  if (!existsSync(path.join(root, "tsconfig.json"))) return undefined;
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  return existsSync(tsc) ? tsc : undefined;
}

function usesCheckJs(root: string): boolean {
  try {
    return /"(checkJs|allowJs)"\s*:\s*true/.test(readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  } catch {
    return false;
  }
}

let pythonCache: string | null | undefined;
async function findPython(root: string): Promise<string | undefined> {
  if (pythonCache !== undefined) return pythonCache ?? undefined;
  for (const candidate of process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"]) {
    // The Windows Store stub "python" prints a message and fails instead of running.
    const r = await execa(candidate, ["-c", "print(1)"], { cwd: root, reject: false, timeout: 5000 }).catch(() => undefined);
    if (r && r.exitCode === 0 && r.stdout.trim() === "1") {
      pythonCache = candidate;
      return candidate;
    }
  }
  pythonCache = null;
  return undefined;
}

function toRel(root: string, file: string): string {
  const r = path.relative(root, path.resolve(root, file));
  return r.split(path.sep).join("/");
}

function nonEmpty(s: string): string[] {
  return s.split(/\r?\n/).filter((l) => l.trim());
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Wraps a report as feedback for the model. */
export function diagnosticsNote(report: DiagnosticsReport): string {
  return `Checks after your edits found problems. Fix them before moving on (or explain why they are expected):\n\n${report.text}`;
}
