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

async function mount(turns: FakeTurn[], mode: PermissionMode = "default", opts: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
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
  const app = render(<App agent={agent} root={root} bridge={bridge} allowBypass={false} env={opts.env} />, {
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

  it("runs slash commands", async () => {
    const { stdout, type } = await mount([]);
    await type("/help\r");
    await until(() => stdout.text().includes("Commands:"));
  });
});
