import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readHistory, sparkline, statsReport, usageReport } from "../src/agent/stats.js";
import { Session } from "../src/agent/session.js";
import { makeStatusLine } from "../src/agent/statusLine.js";
import { tempDir } from "./helpers.js";

const NOW = new Date(2026, 10, 23, 15, 0).getTime(); // Mon 23 Nov 2026, 15:00 local
const day = 86_400_000;

async function writeSession(home: string, root: string, id: string, created: number, lines: object[]) {
  const dir = path.join(home, "sessions", `p-${id}`);
  await fs.mkdir(dir, { recursive: true });
  const meta = { t: "meta", v: 1, id, root, model: "x", created: new Date(created).toISOString() };
  await fs.writeFile(path.join(dir, `${id}.jsonl`), [meta, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const usage = (model: string, input: number, output: number, at?: number) => ({ t: "usage", model, u: { inputTokens: input, outputTokens: output }, ...(at ? { at } : {}) });
const prompt = (text: string, at: number) => ({ t: "msg", at, m: { role: "user", content: [{ type: "text", text }] } });
const reply = (at: number, calls: Array<{ name: string; path?: string }> = []) => ({
  t: "msg",
  at,
  m: { role: "assistant", content: calls.map((c, i) => ({ type: "tool_use", id: `c${i}`, name: c.name, input: c.path ? { path: c.path } : {} })) },
});

describe("usage and stats", () => {
  it("adds up usage per period, model and day", async () => {
    const home = await tempDir();
    await writeSession(home, "/proj/a", "s1", NOW - 2 * day, [
      usage("anthropic:claude-opus-5-5", 1_000_000, 100_000, NOW - 2 * day),
      usage("ollama:qwen2.5-coder:3b", 5000, 500, NOW - 2 * day),
    ]);
    // An old session without per-record timestamps falls back to its creation time.
    await writeSession(home, "/proj/b", "s2", NOW - 40 * day, [usage("ollama:qwen2.5-coder:3b", 7000, 700)]);
    await writeSession(home, "/proj/a", "s3", NOW - 60_000, [usage("ollama:qwen2.5-coder:3b", 2000, 200, NOW - 60_000)]);
    const h = readHistory({ FORGE_HOME: home });
    expect(h.usage).toHaveLength(4);
    const report = usageReport(h, { now: NOW, session: { id: "s3", label: "This session" } });
    expect(report).toMatch(/This session\s+1 req\s+2\.0k in\s+200 out\s+\$0 \(local\)/);
    expect(report).toMatch(/Today\s+1 req/);
    expect(report).toMatch(/Last 7 days\s+3 req/);
    expect(report).toMatch(/All time\s+4 req/);
    expect(report).toContain("anthropic:claude-opus-5-5");
    expect(report).toMatch(/This month by model:\nanthropic:claude-opus-5-5/);
    expect(report).toMatch(/Last 14 days \(tokens\): [·▁-█]{14}/);
    expect(readHistory({ FORGE_HOME: home }, { root: "/proj/b" }).usage).toHaveLength(1);
  });

  it("reports activity, tools, files and a heatmap", async () => {
    const home = await tempDir();
    await writeSession(home, "/proj", "s1", NOW - day, [
      prompt("fix the bug", NOW - day),
      reply(NOW - day, [{ name: "read", path: "src/a.ts" }, { name: "grep" }]),
      { t: "msg", at: NOW - day, m: { role: "user", content: [{ type: "tool_result", toolUseId: "c0", content: "x" }] } },
      reply(NOW - day, [{ name: "edit", path: "src/a.ts" }]),
      prompt("<system-reminder>\nnot typed\n</system-reminder>", NOW - day),
      prompt("thanks", NOW),
      reply(NOW),
    ]);
    const out = statsReport(readHistory({ FORGE_HOME: home }), { now: NOW });
    expect(out).toContain("Sessions: 1 (1 in the last 30 days) · prompts: 2 · active days: 2");
    expect(out).toContain("Model requests per prompt: 1.5");
    expect(out).toMatch(/read\s+1/);
    expect(out).toMatch(/2 {2}src\/a\.ts/);
    expect(out).toMatch(/Mon {16}█/); // 15:00 on a Monday
  });

  it("timestamps new session records", async () => {
    const home = await tempDir();
    const s = new Session("/proj", "fake:m", { env: { FORGE_HOME: home } });
    s.message({ role: "user", content: [{ type: "text", text: "hi" }] });
    s.usage("fake:m", { inputTokens: 1, outputTokens: 1 });
    const lines = (await fs.readFile(s.file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.slice(1).every((l) => typeof l.at === "number")).toBe(true);
  });

  it("draws sparklines", () => {
    expect(sparkline([0, 1, 2, 4])).toBe("·▂▄█");
    expect(sparkline([0, 0])).toBe("··");
  });
});

describe("status line", () => {
  it("runs the command with the state on stdin", async () => {
    const root = await tempDir();
    const run = makeStatusLine({ command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.model+' '+j.context.percent+'%');console.log('two');console.log('three')})"` }, root);
    const text = await run({ cwd: root, model: "ollama:m", permission_mode: "default", context: { tokens: 10, window: 100, percent: 10 }, cost_usd: 0, tokens: { input: 1, output: 2 } });
    expect(text).toBe("ollama:m 10%\ntwo");
    const failing = makeStatusLine({ command: "exit 3" }, root);
    expect(await failing({ cwd: root, model: "m", permission_mode: "default", context: { tokens: 0, window: 1, percent: 0 }, cost_usd: 0, tokens: { input: 0, output: 0 } })).toMatch(/exit 3/);
  });
});
