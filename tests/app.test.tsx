import { BUILTIN_AGENTS, type AgentType } from "../src/agent/subagents.js";
import { makeTaskTool } from "../src/tools/task.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/loop.js";
import { Session } from "../src/agent/session.js";
import { filterMouse } from "../src/ui/mouseStdin.js";
import { Permissions, type PermissionMode } from "../src/permissions/index.js";
import { FakeProvider, type FakeTurn } from "../src/providers/fake.js";
import { defaultTools } from "../src/tools/registry.js";
import { App, type AskBridge } from "../src/ui/App.js";
import type { ComponentProps } from "react";
type AppProps = ComponentProps<typeof App>;
import { tempDir } from "./helpers.js";

class FakeStdout extends Writable {
  frames: string[] = [];
  columns = 100;
  rows = 40;
  isTTY = true;
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.frames.push(chunk.toString());
    cb();
  }
  text() {
    return this.frames.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

function fakeStdin() {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(b: boolean): void; ref(): void; unref(): void };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for UI: ${fn.toString().slice(0, 120)}`);
    await sleep(20);
  }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function mount(
  turns: FakeTurn[],
  mode: PermissionMode = "default",
  opts: { root?: string; env?: NodeJS.ProcessEnv; extra?: Partial<AppProps>; agent?: Partial<ConstructorParameters<typeof Agent>[0]> } = {},
) {
  const root = opts.root ?? (await tempDir());
  const bridge: AskBridge = {};
  const agent = new Agent({
    provider: new FakeProvider(turns),
    model: "fake",
    system: "test",
    tools: defaultTools(),
    permissions: new Permissions(mode, (req) => bridge.ask!(req)),
    root,
    ...opts.agent,
  });
  const stdout = new FakeStdout();
  const stdin = fakeStdin();
  const filtered = filterMouse(stdin);
  const app = render(<App agent={agent} root={root} bridge={bridge} allowBypass={false} env={opts.env} mouse={filtered.mouse} {...opts.extra} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: filtered.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
  });
  cleanup = () => app.unmount();
  const type = async (s: string) => {
    for (const ch of s) {
      stdin.write(ch);
      await sleep(5);
    }
  };
  /** Write one chunk at once, as a terminal sends an escape sequence. */
  const send = async (s: string) => {
    stdin.write(s);
    await sleep(20);
  };
  return { root, agent, stdout, type, send };
}

describe("TUI subagents", () => {
  it("shows a background agent finishing and carries on with its report", async () => {
    const helper = new FakeProvider([{ toolCalls: [{ name: "ls", input: {} }] }, { text: "found 3 files", delayMs: 80 }], "helper");
    const types: AgentType[] = [...BUILTIN_AGENTS, { name: "bg", description: "x", tools: "readonly", model: "helper:m", prompt: "p", source: "test" }];
    const { stdout, type, agent } = await mount(
      [
        { toolCalls: [{ name: "task", input: { description: "count files", prompt: "count", subagent_type: "bg", run_in_background: true } }] },
        { text: "Started; I'll report back." },
        { text: "The helper found 3 files." },
      ],
      "bypass",
      { agent: { tools: [...defaultTools(), makeTaskTool(types)], agentTypes: types, resolveModel: async () => ({ provider: helper, model: "m" }) } },
    );
    await type("count the files\r");
    await until(() => stdout.text().includes("Started; I'll report back."));
    await until(() => stdout.text().includes("Background agent agent-1 (count files) finished"));
    await until(() => stdout.text().includes("The helper found 3 files."));
    expect(agent.pendingNotes).toBe(0);
  });
});

describe("TUI", () => {
  it("streams an answer for a submitted prompt", async () => {
    const { stdout, type } = await mount([{ text: "Hello from **forge**" }]);
    await until(() => stdout.text().includes("forge"));
    await type("hi\r");
    await until(() => stdout.text().includes("Hello from forge"));
  });

  it("asks permission through the dialog and runs the tool on yes", async () => {
    const { root, stdout, type } = await mount([
      { toolCalls: [{ name: "write", input: { path: "a.txt", content: "x" } }] },
      { text: "Wrote it." },
    ]);
    await type("go\r");
    await until(() => stdout.text().includes("Allow write?"));
    await sleep(100); // let the dialog's input subscription attach
    await type("1");
    await until(() => stdout.text().includes("Wrote it."));
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("x");
  });

  it("cycles permission modes with Shift+Tab", async () => {
    const { agent, stdout, type } = await mount([]);
    await until(() => stdout.text().includes("ask before edits"));
    await type("\x1b[Z"); // Shift+Tab
    await until(() => agent.permissions.mode === "acceptEdits");
    await type("\x1b[Z");
    await until(() => agent.permissions.mode === "plan");
    expect(stdout.text()).toContain("plan mode");
  });

  it("resumes a saved session from the /resume picker", async () => {
    const home = await tempDir();
    const root = await tempDir();
    const env = { FORGE_HOME: home };
    const saved = new Session(root, "fake", { env });
    saved.message({ role: "user", content: [{ type: "text", text: "fix the flaky test" }] });
    saved.message({ role: "assistant", content: [{ type: "text", text: "Fixed it earlier." }] });

    const { agent, stdout, type } = await mount([], "default", { root, env });
    await type("/resume\r");
    await until(() => stdout.text().includes("Resume a conversation"));
    await sleep(100);
    await type("\r");
    await until(() => stdout.text().includes("Resumed session"));
    expect(stdout.text()).toContain("Fixed it earlier.");
    expect(agent.messages).toHaveLength(2);
  });

  it("picks a model from the /model list", async () => {
    const switched: string[] = [];
    const { stdout, type } = await mount([], "default", {
      extra: {
        listModels: async () => [
          { spec: "fake:fake", provider: "ollama", label: "fake", available: true },
          { spec: "ollama:qwen2.5-coder:3b", provider: "ollama", label: "qwen2.5-coder:3b", available: true, note: "3.1B · 32k ctx" },
          { spec: "gemini:gemini-2.5-pro", provider: "gemini", label: "Gemini 2.5 Pro", available: false, note: "needs GEMINI_API_KEY" },
        ],
        switchModel: async (spec: string) => {
          switched.push(spec);
        },
      },
    });
    await type("/model\r");
    await until(() => stdout.text().includes("Select a model") && stdout.text().includes("needs GEMINI_API_KEY"));
    expect(stdout.text()).toContain("✓ current");
    await sleep(100);
    await type("\x1b[B"); // down: from the current model to qwen
    await type("\r");
    await until(() => switched.length === 1);
    expect(switched).toEqual(["ollama:qwen2.5-coder:3b"]);
    await until(() => stdout.text().includes("Switched to"));
  });

  it("shows matching commands while typing and navigates them with arrow keys", async () => {
    const opened: string[] = [];
    const { stdout, type } = await mount([], "default", {
      extra: {
        listModels: async () => {
          opened.push("picker");
          return [{ spec: "fake:fake", provider: "ollama", label: "fake", available: true }];
        },
      },
    });
    await type("/mod");
    await until(() => /❯ \/mode\b/.test(stdout.text()) && stdout.text().includes("/models"));
    expect(stdout.text()).toContain("/model [provider:model]");

    // Down twice: /mode → /model → /models, then Enter runs it.
    await type("\x1b[B");
    await type("\x1b[B");
    await until(() => /❯ \/models/.test(stdout.text()));
    await type("\r");
    await until(() => opened.length === 1 && stdout.text().includes("Select a model"));
  });

  it("scrolls a long command list to keep the selection visible", async () => {
    const { stdout, type } = await mount([]);
    await type("/");
    await until(() => /↓ \d+ more/.test(stdout.text()));
    for (let i = 0; i < 8; i++) await type("\x1b[B");
    await until(() => /↑ \d+ more/.test(stdout.text()));
  });

  it("wraps around, completes with Tab and closes with Esc", async () => {
    const { stdout, type } = await mount([]);
    await type("/mod");
    await until(() => /❯ \/mode\b/.test(stdout.text()));
    await type("\x1b[A"); // up from the first entry wraps to the last
    await until(() => /❯ \/models/.test(stdout.text()));
    await type("\t");
    await until(() => stdout.text().includes("> /models"));
    await type("\x1b");
    await sleep(50);
    await type("\r"); // menu closed: Enter submits the typed text as-is
    await until(() => stdout.text().includes("Model: fake:fake"));
  });

  it("previews themes live in /themes and saves the one picked", async () => {
    const saved: string[] = [];
    const { stdout, type } = await mount([], "default", { extra: { saveTheme: (n: string) => saved.push(n) } });
    await type("/themes\r");
    await until(() => stdout.text().includes("Pick a theme") && stdout.text().includes("Synthwave"));
    expect(stdout.text()).toContain("fix the failing test"); // the sample transcript
    await sleep(100);
    await type("\x1b[B"); // Forge → Ember (previewed, not saved yet)
    await sleep(100);
    expect(saved).toEqual([]);
    await type("\r");
    await until(() => stdout.text().includes("Theme set to Ember"));
    expect(saved).toEqual(["ember"]);
  });

  it("sets a theme by name and rejects unknown ones", async () => {
    const saved: string[] = [];
    const { stdout, type } = await mount([], "default", { extra: { saveTheme: (n: string) => saved.push(n) } });
    await type("/theme ocean\r");
    await until(() => stdout.text().includes("Theme set to Ocean"));
    await type("/theme plaid\r");
    await until(() => stdout.text().includes('No theme "plaid"'));
    expect(saved).toEqual(["ocean"]);
  });

  it("adopts a pet from /pets and pets it with clicks and Ctrl+P", async () => {
    const saved: unknown[] = [];
    const { stdout, type, send } = await mount([], "default", { extra: { savePet: (p) => saved.push(p) } });
    await type("/pets\r");
    await until(() => stdout.text().includes("Adopt a pet") && stdout.text().includes("Octopus"));
    await sleep(100);
    await type("\x1b[C"); // → Dog
    await sleep(50);
    await type("\r");
    await until(() => stdout.text().includes("You adopted Biscuit the dog"));
    // Clicks are opt-in, so text selection keeps working by default.
    expect(saved.at(-1)).toMatchObject({ kind: "dog", name: "Biscuit", clicks: false });
    await sleep(100);
    expect(stdout.frames.join("")).not.toContain("\x1b[?1000h");
    await type("/pet clicks on\r");
    await until(() => stdout.frames.join("").includes("\x1b[?1000h"));

    await sleep(100);
    await send("\x1b[<0;10;5M"); // a left click
    await until(() => stdout.text().includes("Biscuit ♥ 1"));
    await type("\x10"); // Ctrl+P
    await until(() => stdout.text().includes("Biscuit ♥ 2"));
    // The click never reached the prompt.
    expect(stdout.text()).not.toContain("> [<0");
  });

  it("throws a party after ten quick clicks, and can be renamed and hidden", async () => {
    const saved: Array<{ kind: string; name?: string; clicks: boolean }> = [];
    const { stdout, type, send } = await mount([], "default", {
      extra: { initialPet: { kind: "cat", clicks: true }, savePet: (p) => saved.push(p) },
    });
    await until(() => stdout.text().includes("Mochi"));
    await sleep(100);
    for (let i = 0; i < 10; i++) await send("\x1b[<0;3;3M");
    await until(() => stdout.text().includes("PARTY!!!"));
    await type("/pet name Whiskers\r");
    await until(() => stdout.text().includes("now called Whiskers"));
    await type("/pet clicks off\r");
    await until(() => stdout.frames.join("").includes("\x1b[?1000l"));
    await type("/pet hide\r");
    await until(() => stdout.text().includes("Pet hidden"));
    expect(saved.map((s) => [s.kind, s.name, s.clicks])).toEqual([
      ["cat", "Whiskers", true],
      ["cat", "Whiskers", false],
      ["none", "Whiskers", false],
    ]);
  });

  it("shows a plan for approval and leaves plan mode when it is accepted", async () => {
    const { agent, stdout, type } = await mount(
      [{ toolCalls: [{ name: "exit_plan_mode", input: { plan: "## Plan\n1. Add **a.txt**" } }] }, { text: "Implementing now." }],
      "plan",
    );
    await until(() => stdout.text().includes("plan mode (read-only)"));
    await type("add a file\r");
    await until(() => stdout.text().includes("Here is Forge's plan") && stdout.text().includes("Yes, and auto-accept edits"));
    expect(stdout.text()).toContain("1. Add a.txt");
    await sleep(100);
    await type("1");
    await until(() => stdout.text().includes("Implementing now."));
    expect(agent.permissions.mode).toBe("acceptEdits");
    await until(() => stdout.text().includes("auto-accept"));
  });

  it("warns about dangerous commands and offers no 'don't ask again'", async () => {
    const { stdout, type } = await mount([{ toolCalls: [{ name: "bash", input: { command: "git push --force" } }] }, { text: "ok" }]);
    await type("push it\r");
    await until(() => stdout.text().includes("Allow bash?"));
    expect(stdout.text()).toContain("⚠ This command force-pushes");
    expect(stdout.text()).not.toContain("don't ask again");
    await sleep(100);
    await type("2"); // "No" is option 2 here
    await until(() => stdout.text().includes("Reason"));
    await type("\r");
    await until(() => stdout.text().includes("denied"));
  });

  it("shows the live task list above the prompt and hides it with Ctrl+T", async () => {
    const todos = [
      { content: "Read the code", status: "completed" },
      { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Run the tests", status: "pending" },
    ];
    const { stdout, type } = await mount([{ toolCalls: [{ name: "todo_write", input: { todos } }] }, { text: "On it.", delayMs: 400 }]);
    await type("fix it\r");
    await until(() => stdout.text().includes("Tasks") && stdout.text().includes("1/3 done") && stdout.text().includes("Fixing the bug"));
    expect(stdout.text()).toContain("☐ Run the tests");
    await until(() => stdout.text().includes("On it."));
    const before = stdout.frames.length;
    await type("\x14"); // Ctrl+T
    await until(() => stdout.frames.length > before);
    await sleep(50);
    expect(stdout.frames.slice(before).join("")).not.toContain("1/3 done");
  });

  it("shows the context breakdown and compacts on request", async () => {
    const { agent, stdout, type } = await mount([{ text: "First answer." }, { text: "## Request\nsay hi" }]);
    await type("hi\r");
    await until(() => stdout.text().includes("First answer."));
    await type("/context\r");
    await until(() => stdout.text().includes("Tool definitions") && stdout.text().includes("Auto-compact at"));
    await type("/compact\r");
    await until(() => stdout.text().includes("Compacted the conversation"));
    expect(agent.messages[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("say hi") });
  });

  it("sets the context size with /context <size>", async () => {
    const calls: Array<number | "auto" | undefined> = [];
    const { stdout, type } = await mount([], "default", {
      extra: {
        setContextLength: async (tokens) => {
          calls.push(tokens);
          return { text: typeof tokens === "number" ? `now runs with a ${tokens / 1024}k context. It fits entirely on the GPU.` : "back to the default" };
        },
      },
    });
    await type("/context 32k\r");
    await until(() => stdout.text().includes("now runs with a 32k context"));
    await type("/context default\r");
    await until(() => stdout.text().includes("back to the default"));
    await type("/context huge\r");
    await until(() => stdout.text().includes("Usage: /context"));
    expect(calls).toEqual([32768, undefined]);
  });

  it("lists rules with /permissions", async () => {
    const { stdout, type } = await mount([]);
    await type("/permissions\r");
    await until(() => stdout.text().includes("Permission mode: default") && stdout.text().includes("always ask"));
  });

  it("runs slash commands", async () => {
    const { stdout, type } = await mount([]);
    await type("/help\r");
    await until(() => stdout.text().includes("Commands:"));
  });
});
