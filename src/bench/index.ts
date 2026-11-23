import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../agent/loop.js";
import { buildSystemPrompt } from "../agent/systemPrompt.js";
import { Permissions } from "../permissions/index.js";
import type { Provider } from "../providers/types.js";
import { defaultTools } from "../tools/registry.js";

export interface BenchTask {
  id: string;
  title: string;
  prompt: string;
  /** Files to create before the run: relative path → contents. */
  files: Record<string, string>;
  /** Did the model succeed? Gets the project directory and the final answer. */
  check(dir: string, answer: string): Promise<boolean>;
}

const read = (dir: string, f: string) => fs.readFile(path.join(dir, f), "utf8").catch(() => undefined);

/** Small, fixed tasks covering the basics: create, fix, find, run, multi-file edit. */
export const BENCH_TASKS: BenchTask[] = [
  {
    id: "create",
    title: "Create a file",
    prompt: "Create a file named hello.txt that contains exactly this text: hello forge",
    files: {},
    check: async (dir) => (await read(dir, "hello.txt"))?.trim() === "hello forge",
  },
  {
    id: "fix",
    title: "Fix a bug",
    prompt: "The add function in math.js is wrong: it subtracts instead of adding. Fix it.",
    files: { "math.js": "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n" },
    check: async (dir) => {
      const s = (await read(dir, "math.js")) ?? "";
      return /return\s+a\s*\+\s*b/.test(s) && !/a\s*-\s*b/.test(s) && /return\s+a\s*\*\s*b/.test(s);
    },
  },
  {
    id: "find",
    title: "Find a fact",
    prompt: "Which port does the server in this project listen on? Answer with just the number.",
    files: {
      "README.md": "# Demo\n\nA small service.\n",
      "src/index.js": 'import { start } from "./server/app.js";\nstart();\n',
      "src/server/app.js": 'import { config } from "./config.js";\nexport function start() {\n  console.log("listening on", config.port);\n}\n',
      "src/server/config.js": "export const config = {\n  host: \"0.0.0.0\",\n  port: 8123,\n};\n",
    },
    check: async (_dir, answer) => /\b8123\b/.test(answer),
  },
  {
    id: "run",
    title: "Run a command",
    prompt: "How many lines does data.txt have? Count them with a shell command and answer with just the number.",
    files: { "data.txt": Array.from({ length: 37 }, (_, i) => `row ${i + 1}`).join("\n") + "\n" },
    check: async (_dir, answer) => /\b37\b/.test(answer),
  },
  {
    id: "rename",
    title: "Edit two files",
    prompt: "Rename the function greet to welcome everywhere in this project.",
    files: {
      "lib/greet.js": 'export function greet(name) {\n  return "Hello, " + name;\n}\n',
      "main.js": 'import { greet } from "./lib/greet.js";\nconsole.log(greet("Ada"));\n',
    },
    check: async (dir) => {
      const a = (await read(dir, "lib/greet.js")) ?? "";
      const b = (await read(dir, "main.js")) ?? "";
      return /function\s+welcome\s*\(/.test(a) && /welcome\(/.test(b) && !/\bgreet\s*\(/.test(a + b);
    },
  },
];

export interface BenchResult {
  spec: string;
  task: string;
  ok: boolean;
  seconds: number;
  outputTokens: number;
  /** Model requests the task took. */
  turns: number;
  error?: string;
  /** The final answer and tool calls, for seeing why a task failed. */
  trace?: string;
}

export interface BenchOptions {
  specs: string[];
  resolve(spec: string): Promise<{ provider: Provider; model: string; spec: string }>;
  tasks?: BenchTask[];
  /** Per task (default 180 s). */
  timeoutSeconds?: number;
  /** Requests per task before it counts as failed (default 15). */
  maxTurns?: number;
  onProgress?(line: string): void;
  signal?: AbortSignal;
}

/** Run every task against every model, each in a fresh temporary project. */
export async function runBench(opts: BenchOptions): Promise<BenchResult[]> {
  const tasks = opts.tasks ?? BENCH_TASKS;
  const results: BenchResult[] = [];
  for (const requested of opts.specs) {
    if (opts.signal?.aborted) break;
    let resolved: Awaited<ReturnType<BenchOptions["resolve"]>>;
    try {
      resolved = await opts.resolve(requested);
    } catch (err) {
      opts.onProgress?.(`${requested}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    opts.onProgress?.(`${resolved.spec}: loading…`);
    // Untimed warm-up, so loading the model doesn't count against the first task.
    try {
      for await (const _ of resolved.provider.stream({
        model: resolved.model,
        system: "Reply with OK.",
        messages: [{ role: "user", content: [{ type: "text", text: "Say OK." }] }],
        tools: [],
        maxTokens: 8,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })) {
        // drain
      }
    } catch (err) {
      opts.onProgress?.(`${resolved.spec}: couldn't run (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    for (const task of tasks) {
      if (opts.signal?.aborted) break;
      const r = await runTask(resolved, task, opts);
      results.push(r);
      opts.onProgress?.(
        `${resolved.spec} · ${task.title}: ${r.ok ? "✔ pass" : "✘ fail"} in ${r.seconds.toFixed(1)}s (${r.turns} request${r.turns === 1 ? "" : "s"})${r.error ? ` (${r.error})` : ""}${!r.ok && process.env.FORGE_BENCH_TRACE ? `\n${r.trace}` : ""}`,
      );
    }
  }
  return results;
}

async function runTask(m: { provider: Provider; model: string; spec: string }, task: BenchTask, opts: BenchOptions): Promise<BenchResult> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "forge-bench-")));
  for (const [f, content] of Object.entries(task.files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), content);
  }
  const agent = new Agent({
    provider: m.provider,
    model: m.model,
    system: buildSystemPrompt({ root: dir, cwd: dir, model: m.spec }),
    tools: defaultTools(),
    // No one to ask: everything inside the throwaway project runs; destructive commands are still refused.
    permissions: new Permissions("bypass", undefined, { root: dir }),
    root: dir,
    autoCompact: false,
  });
  const ac = new AbortController();
  const stop = () => ac.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, (opts.timeoutSeconds ?? 180) * 1000);
  const maxTurns = opts.maxTurns ?? 15;
  const started = performance.now();
  let turns = 0;
  let answer = "";
  let error: string | undefined;
  try {
    for await (const ev of agent.send(task.prompt, ac.signal)) {
      if (ev.type === "assistant_message" && ++turns >= maxTurns) {
        error = `gave up after ${maxTurns} requests`;
        ac.abort();
      }
      if (ev.type === "done") {
        answer = ev.text;
        if (ev.stop === "aborted" && !error) error = opts.signal?.aborted ? "interrupted" : "timed out";
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  }
  const seconds = (performance.now() - started) / 1000;
  const ok = !error && (await task.check(dir, answer).catch(() => false));
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  const trace = agent.messages
    .flatMap((msg) => msg.content.map((b) => (b.type === "text" ? `${msg.role}: ${b.text}` : b.type === "tool_use" ? `call ${b.name} ${JSON.stringify(b.input)}` : b.type === "tool_result" ? `result: ${typeof b.content === "string" ? b.content : "[blocks]"}` : "")))
    .filter(Boolean)
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
    .join("\n");
  return { spec: m.spec, task: task.id, ok, seconds, outputTokens: agent.usage.outputTokens, turns, trace, ...(error ? { error } : {}) };
}

/** A table: one row per model with passes, total time and output speed. */
export function formatBench(results: BenchResult[], tasks: BenchTask[] = BENCH_TASKS): string {
  const specs = [...new Set(results.map((r) => r.spec))];
  if (!specs.length) return "No results.";
  const rows = specs.map((spec) => {
    const rs = results.filter((r) => r.spec === spec);
    const passed = rs.filter((r) => r.ok).length;
    const secs = rs.reduce((n, r) => n + r.seconds, 0);
    const tokens = rs.reduce((n, r) => n + r.outputTokens, 0);
    const marks = tasks.map((t) => {
      const r = rs.find((x) => x.task === t.id);
      return r ? (r.ok ? "✔" : "✘") : "·";
    });
    return { spec, score: `${passed}/${rs.length}`, marks: marks.join(" "), time: `${secs.toFixed(0)}s`, speed: secs ? `${(tokens / secs).toFixed(1)} tok/s` : "-" };
  });
  const w = Math.max(5, ...rows.map((r) => r.spec.length));
  const header = `${"Model".padEnd(w)}  Score  ${tasks.map((_, i) => i + 1).join(" ")}  Time   Output`;
  const lines = rows.map((r) => `${r.spec.padEnd(w)}  ${r.score.padEnd(5)}  ${r.marks}  ${r.time.padEnd(5)}  ${r.speed}`);
  const legend = tasks.map((t, i) => `${i + 1} = ${t.title.toLowerCase()}`).join(", ");
  return [header, ...lines, "", legend].join("\n");
}
