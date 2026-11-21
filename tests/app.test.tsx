import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/loop.js";
import { Session } from "../src/agent/session.js";
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
    if (Date.now() > end) throw new Error("timed out waiting for UI");
    await sleep(20);
  }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function mount(turns: FakeTurn[], mode: PermissionMode = "default", opts: { root?: string; env?: NodeJS.ProcessEnv; extra?: Partial<AppProps> } = {}) {
  const root = opts.root ?? (await tempDir());
  const bridge: AskBridge = {};
  const agent = new Agent({
    provider: new FakeProvider(turns),
    model: "fake",
    system: "test",
    tools: defaultTools(),
    permissions: new Permissions(mode, (req) => bridge.ask!(req)),
    root,
  });
  const stdout = new FakeStdout();
  const stdin = fakeStdin();
  const app = render(<App agent={agent} root={root} bridge={bridge} allowBypass={false} env={opts.env} {...opts.extra} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
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
  return { root, agent, stdout, type };
}

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

  it("runs slash commands", async () => {
    const { stdout, type } = await mount([]);
    await type("/help\r");
    await until(() => stdout.text().includes("Commands:"));
  });
});
