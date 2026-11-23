import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, looksUnfinished, type AgentEvent } from "../src/agent/loop.js";
import { runDiagnostics } from "../src/agent/diagnostics.js";
import { BENCH_TASKS, formatBench, runBench } from "../src/bench/index.js";
import { loadConfig } from "../src/config/index.js";
import { Permissions } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import { estimateVram, kvBytesPerElement, kvBytesPerToken, largestFit, stepDown } from "../src/providers/ollamaFit.js";
import { extractToolCalls, repetitionCut } from "../src/providers/openai.js";
import { canonicalToolName } from "../src/providers/toolNames.js";
import type { JsonRequest, JsonResult } from "../src/providers/types.js";
import { defaultTools } from "../src/tools/registry.js";
import { editTool, locate } from "../src/tools/edit.js";
import { readTool } from "../src/tools/read.js";
import { extractSymbols, renderMap, repoMapTool } from "../src/tools/repoMap.js";
import { similarPaths } from "../src/tools/suggest.js";
import { makeCtx, tempDir } from "./helpers.js";

/** A fake local model that can also produce schema-constrained JSON. */
class JsonFake extends FakeProvider {
  readonly jsonRequests: JsonRequest[] = [];
  constructor(
    turns: FakeTurn[],
    private readonly json: unknown[],
  ) {
    super(turns, "ollama");
  }
  async generateJson(req: JsonRequest): Promise<JsonResult> {
    this.jsonRequests.push(req);
    return { value: this.json.shift(), usage: { inputTokens: 7, outputTokens: 3 } };
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function agentFor(provider: FakeProvider, extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const root = await tempDir();
  const agent = new Agent({ provider, model: "m", system: "s", tools: defaultTools(), permissions: new Permissions("bypass", undefined, { root }), root, ...extra });
  return { root, agent };
}

const toolResults = (p: FakeProvider, request: number) =>
  p.requests[request]!.messages.at(-1)!.content.flatMap((b) => (b.type === "tool_result" ? [b] : []));

describe("tool names", () => {
  const known = new Set(["read", "write", "edit", "bash", "ls", "grep", "glob", "todo_write"]);
  it("maps names small models invent to the real tools", () => {
    expect(canonicalToolName("read_file", known)).toBe("read");
    expect(canonicalToolName("functions.bash", known)).toBe("bash");
    expect(canonicalToolName("runCommand", known)).toBe("bash");
    expect(canonicalToolName("list-files", known)).toBe("ls");
    expect(canonicalToolName("Write", known)).toBe("write");
    expect(canonicalToolName("delete_everything", known)).toBeUndefined();
    // Only to tools that exist.
    expect(canonicalToolName("repomap", known)).toBeUndefined();
  });

  it("accepts aliases in text-form tool calls and in native calls", async () => {
    const found = extractToolCalls('{"name": "read_file", "arguments": {"path": "a.txt"}}', known);
    expect(found.calls).toEqual([{ name: "read", args: { path: "a.txt" } }]);

    const p = new FakeProvider([{ toolCalls: [{ name: "write_file", input: { path: "x.txt", content: "hi" } }] }, { text: "ok" }]);
    const { root, agent } = await agentFor(p);
    const events = await collect(agent.send("go"));
    expect(await fs.readFile(path.join(root, "x.txt"), "utf8")).toBe("hi");
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ name: "write" });
  });
});

describe("repairing malformed tool calls", () => {
  it("re-asks with the tool's schema and runs the fixed call", async () => {
    const p = new JsonFake(
      [{ text: "Writing the file.", toolCalls: [{ name: "write", input: { file: "notes.txt", text: "remember" } }] }, { text: "Done." }],
      [{ path: "notes.txt", content: "remember" }],
    );
    const { root, agent } = await agentFor(p);
    const events = await collect(agent.send("save a note saying remember"));
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("remember");
    expect(events).toContainEqual({ type: "notice", text: "Fixed malformed arguments for write.", tone: "info" });
    const req = p.jsonRequests[0]!;
    expect(req.schema).toMatchObject({ type: "object", required: ["path", "content"] });
    const ask = JSON.stringify(req.messages);
    expect(ask).toContain("save a note saying remember");
    expect(ask).toContain("Writing the file.");
    expect(ask).toContain("path");
    expect(agent.usage.outputTokens).toBe(5 + 3 + 5);
  });

  it("reports the original problem when the repair doesn't validate either", async () => {
    const p = new JsonFake([{ toolCalls: [{ name: "read", input: "not json {" }] }, { text: "sorry" }], [{ nope: 1 }]);
    const { agent } = await agentFor(p);
    await collect(agent.send("read it"));
    expect(toolResults(p, 1)[0]).toMatchObject({ isError: true, content: expect.stringContaining("Invalid input for read") });
  });

  it("can be turned off", async () => {
    const p = new JsonFake([{ toolCalls: [{ name: "read", input: {} }] }, { text: "x" }], [{ path: "a" }]);
    const { agent } = await agentFor(p, { repairToolCalls: false });
    await collect(agent.send("read"));
    expect(p.jsonRequests).toHaveLength(0);
  });
});

describe("diagnostics after edits", () => {
  it("checks JSON and JavaScript syntax", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "a.json"), '{"x": 1,}');
    await fs.writeFile(path.join(root, "b.js"), "function f( {\n");
    await fs.writeFile(path.join(root, "ok.js"), "export const ok = 1;\n");
    const r = await runDiagnostics(root, [path.join(root, "a.json"), path.join(root, "b.js"), path.join(root, "ok.js")]);
    expect(r.count).toBe(2);
    expect(r.text).toContain("JSON a.json");
    expect(r.text).toContain("node --check b.js");
    expect(r.text).not.toContain("ok.js");
    expect((await runDiagnostics(root, [path.join(root, "ok.js")])).count).toBe(0);
  });

  it("runs a configured command with the changed files", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "x.txt"), "x");
    const failing = await runDiagnostics(root, [path.join(root, "x.txt")], { command: 'echo "lint: problem in {files}"; exit 1' });
    expect(failing.count).toBe(1);
    expect(failing.text).toContain("lint: problem in x.txt");
    expect((await runDiagnostics(root, [path.join(root, "x.txt")], { command: "exit 0" })).count).toBe(0);
  });

  it("feeds problems back to the model with the tool result", async () => {
    const p = new FakeProvider([{ toolCalls: [{ name: "write", input: { path: "conf.json", content: "{ broken" } }] }, { text: "Fixed." }]);
    const { agent } = await agentFor(p);
    const events = await collect(agent.send("write config"));
    expect(events.find((e) => e.type === "notice")).toMatchObject({ tone: "warn", text: expect.stringContaining("1 problem") });
    const last = p.requests[1]!.messages.at(-1)!.content;
    expect(last[0]).toMatchObject({ type: "tool_result" });
    expect(JSON.stringify(last)).toContain("Checks after your edits found problems");

    const quiet = new FakeProvider([{ toolCalls: [{ name: "write", input: { path: "conf.json", content: "{ broken" } }] }, { text: "ok" }]);
    const off = await agentFor(quiet, { diagnostics: false });
    expect((await collect(off.agent.send("go"))).some((e) => e.type === "notice")).toBe(false);
  });
});

describe("repo map", () => {
  it("extracts top-level symbols per language", () => {
    expect(extractSymbols("a.ts", "export function foo() {}\nexport class Bar {}\nexport interface Baz {}\nconst x = 1;\nexport const qux = 2;\nfunction local() {}\n")).toEqual([
      "foo",
      "Bar",
      "Baz",
      "qux",
      "local",
    ]);
    expect(extractSymbols("m.py", "import os\nclass Shop:\n    def buy(self): pass\n\ndef main():\n    pass\ndef helper(x):\n    return x\n")).toEqual(["Shop", "helper"]);
    expect(extractSymbols("s.go", "package x\nfunc (s *Server) Start() {}\ntype Server struct{}\nfunc New() *Server { return nil }\n")).toEqual(["Start", "Server", "New"]);
    expect(extractSymbols("notes.md", "# hi")).toEqual([]);
  });

  it("fits the map to a budget", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ file: `src/m${i}.ts`, symbols: Array.from({ length: 20 }, (_, j) => `fn${j}`) }));
    expect(renderMap(entries, 1_000_000)).toContain("fn19");
    const small = renderMap(entries, 3000);
    expect(small.length).toBeLessThanOrEqual(3000);
    expect(small).toContain("src/m39.ts");
    expect(renderMap(entries, 200)).toMatch(/^Too many files/);
  });

  it("maps a project", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "app.ts"), "export function start() {}\n");
    await fs.writeFile(path.join(root, "node_modules", "dep", "index.js"), "export function hidden() {}\n");
    await fs.writeFile(path.join(root, "README.md"), "# x\n");
    const r = await repoMapTool.run({}, makeCtx(root));
    expect(r.content).toBe("1 source files\nsrc/app.ts: start");
  });
});

describe("Ollama context fitting", () => {
  // qwen2.5-coder:3b: 36 layers, 2 KV heads of 128 dims, ~1.9 GB of weights.
  const shape = { weights: 1.93e9, layers: 36, kvHeads: 2, headDim: 128, maxContext: 32_768 };
  const q8 = { OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0" };

  it("sizes the KV cache from the cache type", () => {
    expect(kvBytesPerElement({})).toBe(2);
    expect(kvBytesPerElement({ OLLAMA_KV_CACHE_TYPE: "q8_0" })).toBe(2); // needs flash attention
    expect(kvBytesPerElement(q8)).toBeCloseTo(1.0625);
    expect(kvBytesPerToken(shape, {})).toBe(36_864);
  });

  it("picks the largest context that fits, capped at the model's maximum", () => {
    const gib = 1024 ** 3;
    expect(largestFit(shape, 6 * gib, q8)).toBe(32_768);
    expect(largestFit(shape, 3 * gib, {})).toBe(12_288);
    expect(largestFit(shape, 0.5 * gib, q8)).toBe(8192);
    expect(estimateVram(shape, 16_384, {})).toBeGreaterThan(shape.weights);
    expect(stepDown(32_768)).toBe(24_576);
    expect(stepDown(8192)).toBeUndefined();
  });
});

describe("bench", () => {
  it("scores a model on the tasks", async () => {
    const create = BENCH_TASKS.find((t) => t.id === "create")!;
    const find = BENCH_TASKS.find((t) => t.id === "find")!;
    const provider = new FakeProvider([
      { text: "OK" }, // warm-up
      { toolCalls: [{ name: "write", input: { path: "hello.txt", content: "hello forge\n" } }] },
      { text: "Created." },
      { text: "I think it's 3000." },
    ]);
    const progress: string[] = [];
    const results = await runBench({
      specs: ["fake:m"],
      resolve: async (spec) => ({ provider, model: "m", spec }),
      tasks: [create, find],
      onProgress: (l) => progress.push(l),
    });
    expect(results.map((r) => [r.task, r.ok])).toEqual([
      ["create", true],
      ["find", false],
    ]);
    expect(progress.some((l) => l.includes("Create a file: ✔ pass"))).toBe(true);
    const table = formatBench(results, [create, find]);
    expect(table).toMatch(/fake:m\s+1\/2\s+✔ ✘/);
  });

  it("checks each task's expected outcome", async () => {
    for (const t of BENCH_TASKS) {
      const dir = await tempDir();
      for (const [f, c] of Object.entries(t.files)) {
        await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
        await fs.writeFile(path.join(dir, f), c);
      }
      // Untouched projects and empty answers fail every task.
      expect(await t.check(dir, "")).toBe(false);
    }
  });
});

describe("model roles in settings", () => {
  it("reads models.fast, diagnostics and repairToolCalls", async () => {
    const home = await tempDir();
    await fs.writeFile(
      path.join(home, "settings.json"),
      JSON.stringify({ models: { main: "ollama:big", fast: "ollama:small" }, diagnostics: { command: "npm run lint" }, repairToolCalls: false }),
    );
    const c = loadConfig(home, {}, { FORGE_HOME: home });
    expect(c).toMatchObject({ model: "ollama:big", fastModel: "ollama:small", diagnostics: { command: "npm run lint" }, repairToolCalls: false });
    expect(loadConfig(home, { model: "x:y" }, { FORGE_HOME: home }).model).toBe("x:y");
  });

  it("summarizes with the fast model", async () => {
    const main = new FakeProvider([{ text: "a".repeat(400) }, { text: "b" }]);
    const fast = new FakeProvider([{ text: "## Goal\nsummary" }], "cheap");
    const { agent } = await agentFor(main, { fast: { provider: fast, model: "tiny" } });
    await collect(agent.send("first"));
    const events = await collect(agent.compact({ reason: "manual" }));
    expect(events.at(-1)).toMatchObject({ type: "compact", phase: "end" });
    expect(fast.requests).toHaveLength(1);
    expect(main.requests).toHaveLength(1);
    expect(agent.fastModelSpec).toBe("cheap:tiny");
  });
});

describe("runaway replies", () => {
  it("cuts a reply that keeps repeating itself", () => {
    const loop = "Let me check the file again to be sure. ";
    const text = "Here is the plan.\n" + loop.repeat(60);
    const cut = repetitionCut(text);
    expect(cut).toBeDefined();
    expect(text.slice(0, cut).length).toBeLessThan(200);
    expect(repetitionCut("ordinary prose ".repeat(20))).toBeUndefined();
    expect(repetitionCut(Array.from({ length: 300 }, (_, i) => `line ${i}: value ${i * 7}`).join("\n"))).toBeUndefined();
  });
});

describe("missing files", () => {
  it("suggests real paths with similar names", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "src", "server"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "server", "app.js"), "");
    await fs.writeFile(path.join(root, "src", "server", "config.js"), "");
    await fs.writeFile(path.join(root, "README.md"), "");
    expect(await similarPaths(root, path.join(root, "server.js"))).toEqual(["src/server/app.js", "src/server/config.js"]);
    expect(await similarPaths(root, path.join(root, "app.js"))).toEqual(["src/server/app.js"]);
    const r = await readTool.run({ path: "config.ts" }, makeCtx(root)).catch((e: Error) => e.message);
    expect(r).toBe("File not found: config.ts. Files with similar names: src/server/config.js");
    const none = await readTool.run({ path: "zzz.py" }, makeCtx(root)).catch((e: Error) => e.message);
    expect(none).toMatch(/File not found: zzz\.py\. Use ls, glob or repo_map/);
  });
});

describe("stalled replies", () => {
  it("recognises replies that announce a step without taking it", () => {
    expect(looksUnfinished("Now, let's update main.js:")).toBe(true);
    expect(looksUnfinished("I found it.\n\nNext, I'll run the tests.")).toBe(true);
    expect(looksUnfinished("Let me know if you want anything else?")).toBe(false);
    expect(looksUnfinished("The server listens on port 8123.")).toBe(false);
    expect(looksUnfinished("")).toBe(false);
  });

  it("nudges local models to continue, at most twice", async () => {
    const p = new FakeProvider([{ text: "Let's do this step-by-step:" }, { text: "Now let me edit it:" }, { text: "Still going:" }], "ollama");
    const { agent } = await agentFor(p);
    const events = await collect(agent.send("rename it"));
    expect(events.filter((e) => e.type === "notice")).toHaveLength(2);
    expect(p.requests).toHaveLength(3);
    expect(JSON.stringify(p.requests[1]!.messages.at(-1))).toContain("didn't do it");

    const cloud = new FakeProvider([{ text: "Let's do this:" }], "anthropic");
    await collect((await agentFor(cloud)).agent.send("x"));
    expect(cloud.requests).toHaveLength(1);
  });

  it("offers exit_plan_mode only in plan mode", async () => {
    const p = new FakeProvider([{ text: "a" }, { text: "b" }]);
    const { agent } = await agentFor(p);
    await collect(agent.send("x"));
    expect(p.requests[0]!.tools.map((t) => t.name)).not.toContain("exit_plan_mode");
    agent.permissions.mode = "plan";
    await collect(agent.send("y"));
    expect(p.requests[1]!.tools.map((t) => t.name)).toContain("exit_plan_mode");
  });
});

describe("forgiving edits", () => {
  const file = "export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n";

  it("matches old_string written with different whitespace", () => {
    const r = locate(file, "function add(a, b) { return a - b; }", "function add(a, b) { return a + b; }");
    expect(r.how).toBe("whitespace");
    expect(r.spans).toHaveLength(1);
    expect(file.slice(...r.spans[0]!)).toBe("function add(a, b) {\n  return a - b;\n}");
  });

  it("ignores read's line-number prefixes", () => {
    const r = locate(file, "     2\t  return a - b;", "     2\t  return a + b;");
    expect(r).toMatchObject({ how: "line-numbers", newStr: "  return a + b;" });
  });

  it("edits through the tool and says how it matched", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "math.js"), file);
    const ctx = makeCtx(root);
    await readTool.run({ path: "math.js" }, ctx);
    const r = await editTool.run({ path: "math.js", old_string: "return a -   b;", new_string: "return a + b;" }, ctx);
    expect(r.content).toContain("different whitespace");
    expect(await fs.readFile(path.join(root, "math.js"), "utf8")).toContain("  return a + b;\n");
    await expect(editTool.run({ path: "math.js", old_string: "return nothing here", new_string: "x" }, ctx)).rejects.toThrow(/not found/);
  });

  it("refuses a write to a file read in the same reply", async () => {
    const p = new FakeProvider([
      { toolCalls: [{ name: "read", input: { path: "a.txt" } }, { name: "write", input: { path: "a.txt", content: "clobbered" } }] },
      { text: "ok" },
    ]);
    const { root, agent } = await agentFor(p);
    await fs.writeFile(path.join(root, "a.txt"), "precious");
    await collect(agent.send("change a.txt"));
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("precious");
    expect(toolResults(p, 1)[1]).toMatchObject({ isError: true, content: expect.stringContaining("haven't seen its contents") });
  });
});
