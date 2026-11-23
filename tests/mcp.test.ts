import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandTemplate, extensionDirs, loadCustomCommands, loadPlugins, loadSkills, makeSkillTool, skillsSection } from "../src/agent/extensions.js";
import { Agent, type AgentEvent } from "../src/agent/loop.js";
import { COMMANDS, registerCommands } from "../src/commands/index.js";
import { loadConfig } from "../src/config/index.js";
import { McpManager, mcpToolName } from "../src/mcp/index.js";
import { Permissions } from "../src/permissions/index.js";
import { parseRule, ruleMatches } from "../src/permissions/rules.js";
import { FakeProvider } from "../src/providers/fake.js";
import { htmlToText, webFetchTool } from "../src/tools/webFetch.js";
import { makeCtx, tempDir } from "./helpers.js";

/** A minimal MCP server over stdio: two tools, one read-only. */
const STDIO_SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
console.error("server starting");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [
    { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
    { name: "add", description: "Add numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
  ] } });
  else if (m.method === "tools/call") {
    const a = m.params.arguments;
    if (m.params.name === "echo") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo: " + a.text }] } });
    else send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: String(a.a + a.b) }], isError: false } });
  }
});
`;

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let web: http.Server;
let webURL: string;
let mcpHttpURL: string;
beforeAll(async () => {
  web = http.createServer(async (req, res) => {
    if (req.url === "/page") {
      res.setHeader("content-type", "text/html");
      return res.end(`<html><head><title>Docs</title><style>p{}</style><script>alert(1)</script></head><body><h1>Install</h1><p>Run <code>npm i x</code> &amp; enjoy.</p><ul><li>One</li><li>Two</li></ul><a href="/next">Next page</a></body></html>`);
    }
    if (req.url === "/data") {
      res.setHeader("content-type", "application/json");
      return res.end('{"ok":true,"n":[1,2]}');
    }
    if (req.url === "/mcp") {
      // Streamable HTTP MCP: answers as server-sent events, keeps a session id.
      let raw = "";
      for await (const c of req) raw += c;
      const m = JSON.parse(raw);
      if (!m.id) {
        res.statusCode = 202;
        return res.end();
      }
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("mcp-session-id", "s1");
      const result =
        m.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "remote" } }
          : m.method === "tools/list"
            ? { tools: [{ name: "time.now", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: `session ${req.headers["mcp-session-id"]}` }] };
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const port = (web.address() as AddressInfo).port;
  webURL = `http://127.0.0.1:${port}`;
  mcpHttpURL = `${webURL}/mcp`;
});
afterAll(() => new Promise<void>((r) => web.close(() => r())));

describe("MCP", () => {
  it("connects to a stdio server and runs its tools through the agent", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "server.cjs"), STDIO_SERVER);
    const mcp = new McpManager({ demo: { command: process.execPath, args: ["server.cjs"] }, broken: { command: "forge-no-such-command-xyz" } }, root);
    const tools: import("../src/tools/types.js").Tool[] = [];
    await mcp.start(tools);
    expect(tools.map((t) => t.name)).toEqual(["mcp__demo__echo", "mcp__demo__add"]);
    expect(tools[0]!.readOnly).toBe(true);
    expect(tools[1]!.readOnly).toBe(false);
    expect(mcp.status.find((s) => s.name === "broken")).toMatchObject({ state: "failed", error: expect.stringMatching(/not found|ENOENT|exited/) });
    expect(mcp.describe()).toContain("2 tools: echo, add");

    const provider = new FakeProvider([{ toolCalls: [{ name: "mcp__demo__echo", input: { text: "hi" } }, { name: "mcp__demo__add", input: { a: 2, b: 3 } }] }, { text: "done" }]);
    const agent = new Agent({ provider, model: "m", system: "s", tools, permissions: new Permissions("bypass", undefined, { root }), root });
    await collect(agent.send("use the tools"));
    const results = provider.requests[1]!.messages.at(-1)!.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : []));
    expect(results).toEqual(["echo: hi", "5"]);
    // The server's own JSON schema is what the model sees.
    expect(provider.requests[0]!.tools.find((t) => t.name === "mcp__demo__add")?.jsonSchema).toEqual({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } } });
    await mcp.close();
  });

  it("connects over Streamable HTTP with server-sent events and a session id", async () => {
    const mcp = new McpManager({ remote: { url: mcpHttpURL } }, await tempDir());
    const tools: import("../src/tools/types.js").Tool[] = [];
    await mcp.start(tools);
    expect(tools.map((t) => t.name)).toEqual(["mcp__remote__time_now"]);
    const r = await tools[0]!.run({}, makeCtx(await tempDir()));
    expect(r.content).toBe("session s1");
  });

  it("names tools safely and matches rules with wildcards", () => {
    expect(mcpToolName("git hub", "create.issue")).toBe("mcp__git_hub__create_issue");
    const ctx = { root: "/", summary: "{}" };
    expect(ruleMatches(parseRule("mcp__github__*"), "mcp__github__create_issue", {}, ctx)).toBe(true);
    expect(ruleMatches(parseRule("mcp__github__*"), "mcp__gitlab__x", {}, ctx)).toBe(false);
  });

  it("validates mcpServers in settings", async () => {
    const home = await tempDir();
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ mcpServers: { a: { command: "x" }, b: { url: "https://example.com/mcp" } } }));
    expect(Object.keys(loadConfig(home, {}, { FORGE_HOME: home }).mcpServers)).toEqual(["a", "b"]);
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ mcpServers: { c: {} } }));
    expect(() => loadConfig(home, {}, { FORGE_HOME: home })).toThrow(/either "command" or "url"/);
  });
});

describe("web_fetch", () => {
  it("turns HTML into readable text", () => {
    const t = htmlToText('<title>T</title><h2>Hi</h2><p>a &lt;b&gt; c</p><a href="/x">link</a><script>bad()</script>', "https://site.dev/docs/");
    expect(t).toBe("# T\n\n## Hi\n\na <b> c\n[link](https://site.dev/x)");
  });

  it("fetches pages and JSON, and reports errors", async () => {
    const ctx = makeCtx(await tempDir());
    const page = await webFetchTool.run({ url: `${webURL}/page` }, ctx);
    expect(page.content).toMatch(/^200 OK/);
    expect(page.content).toContain("# Install");
    expect(page.content).toContain("Run npm i x & enjoy.");
    expect(page.content).toContain("- One\n- Two");
    expect(page.content).not.toContain("alert");
    const json = await webFetchTool.run({ url: `${webURL}/data` }, ctx);
    expect(json.content).toContain('"n": [\n    1,');
    const missing = await webFetchTool.run({ url: `${webURL}/gone` }, ctx);
    expect(missing).toMatchObject({ isError: true });
    await expect(webFetchTool.run({ url: "file:///etc/passwd" }, ctx)).rejects.toThrow(/Only http and https/);
  });
});

describe("custom commands, skills and plugins", () => {
  it("loads custom commands and fills in arguments", async () => {
    const root = await tempDir();
    const home = await tempDir();
    await fs.mkdir(path.join(root, ".forge", "commands"), { recursive: true });
    await fs.writeFile(path.join(root, ".forge", "commands", "fix-issue.md"), "---\ndescription: Fix a GitHub issue\nargument-hint: <number>\n---\nRead issue #$1 with gh, then fix it. Notes: $ARGUMENTS");
    await fs.writeFile(path.join(root, ".forge", "commands", "help.md"), "Not allowed to replace /help");
    const cmds = loadCustomCommands(extensionDirs(root, "commands", [], { FORGE_HOME: home }));
    expect(cmds.map((c) => [c.name, c.description, c.args])).toEqual([
      ["fix-issue", "Fix a GitHub issue", "<number>"],
      ["help", "Not allowed to replace /help", undefined],
    ]);
    expect(expandTemplate(cmds[0]!.template, "42 be careful")).toBe("Read issue #42 with gh, then fix it. Notes: 42 be careful");
    expect(expandTemplate("Summarize the diff.", "briefly")).toBe("Summarize the diff.\n\nbriefly");
    const skipped = registerCommands(cmds.map((c) => ({ name: c.name, description: c.description, custom: true, run() {} }) as never));
    expect(skipped).toEqual(["help"]);
    expect(COMMANDS.some((c) => c.name === "fix-issue")).toBe(true);
  });

  it("loads skills, lists them in the prompt and serves them through a tool", async () => {
    const root = await tempDir();
    const dir = path.join(root, ".forge", "skills", "release");
    await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: release\ndescription: Cut a release: bump version, changelog, tag\n---\n1. Run scripts/bump.sh\n2. Tag it");
    await fs.writeFile(path.join(dir, "scripts", "bump.sh"), "echo bump");
    await fs.mkdir(path.join(root, ".forge", "skills", "bad"));
    await fs.writeFile(path.join(root, ".forge", "skills", "bad", "SKILL.md"), "no frontmatter");
    const { skills, errors } = loadSkills([path.join(root, ".forge", "skills")]);
    expect(skills.map((s) => s.name)).toEqual(["release"]);
    expect(errors).toHaveLength(1);
    expect(skillsSection(skills)).toContain("- release: Cut a release");
    const r = await makeSkillTool(skills).run({ name: "release" }, makeCtx(root));
    expect(r.content).toContain("1. Run scripts/bump.sh");
    expect(r.content).toContain("- scripts/bump.sh");
  });

  it("loads plugins with hooks and MCP servers pointing into the plugin", async () => {
    const root = await tempDir();
    const home = await tempDir();
    const dir = path.join(home, "plugins", "lint-kit");
    await fs.mkdir(path.join(dir, "commands"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ description: "Linting helpers", hooks: { PostToolUse: [{ matcher: "edit", command: "node ${PLUGIN_DIR}/lint.js" }] }, mcpServers: { lint: { command: "node", args: ["${PLUGIN_DIR}/server.js"] } } }),
    );
    await fs.writeFile(path.join(dir, "commands", "lint.md"), "Run the linter");
    const { plugins, errors } = loadPlugins(root, { FORGE_HOME: home });
    expect(errors).toEqual([]);
    expect(plugins[0]).toMatchObject({ name: "lint-kit", description: "Linting helpers" });
    expect(plugins[0]!.hooks.PostToolUse![0]!.command).toBe(`node ${dir}/lint.js`);
    expect(plugins[0]!.mcpServers.lint).toMatchObject({ args: [`${dir}/server.js`], cwd: dir });
    expect(loadCustomCommands(extensionDirs(root, "commands", plugins, { FORGE_HOME: home })).map((c) => c.name)).toEqual(["lint"]);
  });
});
