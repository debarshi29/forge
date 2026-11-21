import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent } from "../src/agent/loop.js";
import { Hooks, type HooksConfig } from "../src/hooks/index.js";
import { Permissions, type AskFn } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import type { Block } from "../src/providers/types.js";
import { defaultTools } from "../src/tools/registry.js";
import { tempDir } from "./helpers.js";

/** Write a node script and return a shell command that runs it. */
async function script(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(
    file,
    `let raw = ""; process.stdin.on("data", (d) => (raw += d)); process.stdin.on("end", () => { const ev = JSON.parse(raw); ${body} });`,
  );
  return `node "${file.split(path.sep).join("/")}"`;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function setup(turns: FakeTurn[], hooks: (dir: string) => Promise<HooksConfig>, opts: { mode?: "default" | "bypass" | "plan"; ask?: AskFn } = {}) {
  const root = await tempDir();
  const dir = await tempDir();
  const provider = new FakeProvider(turns);
  const agent = new Agent({
    provider,
    model: "fake",
    system: "test",
    tools: defaultTools(),
    permissions: new Permissions(opts.mode ?? "bypass", opts.ask, { root }),
    root,
    hooks: new Hooks(await hooks(dir), root),
  });
  return { root, dir, provider, agent };
}

const texts = (blocks: Block[]) => blocks.flatMap((b) => (b.type === "text" ? [b.text] : b.type === "tool_result" && typeof b.content === "string" ? [b.content] : []));

describe("Hooks", () => {
  it("matches tools by regex and passes the event on stdin", async () => {
    const dir = await tempDir();
    const log = path.join(dir, "log.jsonl").split(path.sep).join("/");
    const cmd = await script(dir, "log.mjs", `process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(ev) + "\\n");`);
    const hooks = new Hooks({ PreToolUse: [{ matcher: "write|edit", command: cmd }] }, dir);
    expect(hooks.has("PreToolUse", "edit")).toBe(true);
    expect(hooks.has("PreToolUse", "bash")).toBe(false);
    const out = await hooks.run({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "write", tool_input: { path: "a" } });
    expect(out.block).toBeUndefined();
    const logged = JSON.parse((await fs.readFile(log, "utf8")).trim());
    expect(logged).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "write", tool_input: { path: "a" } });
  });

  it("reports failing hooks as warnings without blocking", async () => {
    const dir = await tempDir();
    const cmd = await script(dir, "fail.mjs", `process.stderr.write("boom"); process.exit(1);`);
    const out = await new Hooks({ Stop: [{ command: cmd }] }, dir).run({ hook_event_name: "Stop", cwd: dir });
    expect(out.block).toBeUndefined();
    expect(out.warnings[0]).toMatch(/failed \(exit 1\): boom/);
  });

  it("rejects a bad matcher", () => {
    expect(() => new Hooks({ PreToolUse: [{ matcher: "(", command: "x" }] }, ".")).toThrow(/Invalid PreToolUse hook matcher/);
  });
});

describe("hooks in the agent loop", () => {
  it("PreToolUse exit 2 blocks the call and tells the model why", async () => {
    const { root, provider, agent } = await setup(
      [{ toolCalls: [{ name: "write", input: { path: "secret.txt", content: "x" } }] }, { text: "ok" }],
      async (dir) => ({
        PreToolUse: [
          { matcher: "write", command: await script(dir, "guard.mjs", `if (ev.tool_input.path.includes("secret")) { process.stderr.write("no secrets"); process.exit(2); }`) },
        ],
      }),
    );
    const events = await collect(agent.send("go"));
    await expect(fs.access(path.join(root, "secret.txt"))).rejects.toThrow();
    expect(texts(provider.requests[1]!.messages.at(-1)!.content)[0]).toBe("Blocked by a PreToolUse hook: no secrets");
    expect(events.some((e) => e.type === "hook" && e.text.includes("no secrets"))).toBe(true);
  });

  it("PreToolUse can rewrite the input, which is then validated and permission-checked", async () => {
    const { root, agent } = await setup(
      [{ toolCalls: [{ name: "write", input: { path: "a.txt", content: "original" } }] }, { text: "ok" }],
      async (dir) => ({
        PreToolUse: [
          { command: await script(dir, "mod.mjs", `console.log(JSON.stringify({ updatedInput: { ...ev.tool_input, content: "rewritten" } }));`) },
        ],
      }),
    );
    await collect(agent.send("go"));
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("rewritten");
  });

  it("PostToolUse feedback is appended to the tool result", async () => {
    const { provider, agent } = await setup(
      [{ toolCalls: [{ name: "write", input: { path: "a.ts", content: "x" } }] }, { text: "ok" }],
      async (dir) => ({
        PostToolUse: [{ matcher: "write", command: await script(dir, "lint.mjs", `process.stderr.write("lint: missing semicolon"); process.exit(2);`) }],
      }),
    );
    await collect(agent.send("go"));
    const result = texts(provider.requests[1]!.messages.at(-1)!.content)[0]!;
    expect(result).toMatch(/^Created a.ts/);
    expect(result).toContain("PostToolUse hook feedback:\nlint: missing semicolon");
  });

  it("UserPromptSubmit can block a prompt or add context", async () => {
    const { provider, agent } = await setup([{ text: "answer" }], async (dir) => ({
      UserPromptSubmit: [
        {
          command: await script(
            dir,
            "prompt.mjs",
            `if (ev.prompt.includes("forbidden")) { process.stderr.write("not allowed"); process.exit(2); } console.log("current branch: main");`,
          ),
        },
      ],
    }));
    const blocked = await collect(agent.send("do the forbidden thing"));
    expect(blocked.at(-1)).toMatchObject({ type: "done", stop: "blocked" });
    expect(agent.messages).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);

    await collect(agent.send("hello"));
    const sent = texts(provider.requests[0]!.messages[0]!.content);
    expect(sent[0]).toBe("hello");
    expect(sent[1]).toContain("current branch: main");
  });

  it("a Stop hook can send the model back to work, a bounded number of times", async () => {
    const { provider, agent } = await setup([{ text: "done?" }, { text: "ran tests" }, { text: "x" }, { text: "y" }, { text: "z" }], async (dir) => {
      const counter = path.join(dir, "n").split(path.sep).join("/");
      return {
        Stop: [
          {
            command: await script(
              dir,
              "stop.mjs",
              `const fs = process.getBuiltinModule("node:fs"); const n = fs.existsSync(${JSON.stringify(counter)}) ? +fs.readFileSync(${JSON.stringify(counter)}, "utf8") : 0; fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1)); if (n === 0 && !ev.stop_hook_active) { process.stderr.write("run the tests first"); process.exit(2); }`,
            ),
          },
        ],
      };
    });
    const events = await collect(agent.send("fix it"));
    expect(events.at(-1)).toMatchObject({ type: "done", stop: "end_turn", text: "ran tests" });
    expect(provider.requests).toHaveLength(2);
    expect(texts(provider.requests[1]!.messages.at(-1)!.content)[0]).toContain("run the tests first");

    // A hook that always blocks can't loop forever.
    const always = await setup(
      Array.from({ length: 6 }, (_, i) => ({ text: `t${i}` })),
      async (dir) => ({ Stop: [{ command: await script(dir, "no.mjs", `process.stderr.write("again"); process.exit(2);`) }] }),
    );
    await collect(always.agent.send("go"));
    expect(always.provider.requests).toHaveLength(4); // first try + 3 continues
  });
});

describe("plan mode in the agent loop", () => {
  it("reminds the model it is in plan mode, and switches mode when the plan is approved", async () => {
    const root = await tempDir();
    const provider = new FakeProvider([
      { toolCalls: [{ name: "write", input: { path: "a.txt", content: "x" } }] },
      { toolCalls: [{ name: "exit_plan_mode", input: { plan: "## Plan\n1. write a.txt" } }] },
      { toolCalls: [{ name: "write", input: { path: "a.txt", content: "x" } }] },
      { text: "Done." },
      { text: "next" },
    ]);
    const asked: string[] = [];
    const permissions = new Permissions("plan", async (req) => {
      asked.push(req.kind ?? "tool");
      return { kind: "always" };
    }, { root });
    const agent = new Agent({ provider, model: "fake", system: "s", tools: defaultTools(), permissions, root });

    await collect(agent.send("add a.txt"));
    const first = texts(provider.requests[0]!.messages[0]!.content);
    expect(first[1]).toContain("Plan mode is on");
    // The write in plan mode was refused without asking; the plan was asked about.
    expect(texts(provider.requests[1]!.messages.at(-1)!.content)[0]).toContain("Plan mode is on: only read-only tools");
    expect(asked).toEqual(["plan"]);
    expect(texts(provider.requests[2]!.messages.at(-1)!.content)[0]).toContain("approved your plan");
    expect(permissions.mode).toBe("acceptEdits");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("x");

    // The next prompt says plan mode has ended.
    await collect(agent.send("more"));
    expect(texts(provider.requests[4]!.messages.at(-1)!.content).join("\n")).toContain("Plan mode is off now");
  });
});
