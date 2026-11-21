#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { Agent, type AgentEvent } from "./agent/loop.js";
import { buildSystemPrompt } from "./agent/systemPrompt.js";
import { loadConfig } from "./config/index.js";
import { PERMISSION_MODES, Permissions, type AskFn, type PermissionMode } from "./permissions/index.js";
import { resolveModel } from "./providers/registry.js";
import { defaultTools } from "./tools/registry.js";
import { App, type AskBridge } from "./ui/App.js";

interface Flags {
  print?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: PermissionMode;
  output: "text" | "json";
  cwd?: string;
}

const program = new Command()
  .name("forge")
  .description("A provider-agnostic terminal coding agent")
  .argument("[prompt...]", "prompt for interactive mode")
  .option("-p, --print <prompt>", "run one prompt headlessly and print the result")
  .option("-m, --model <model>", 'model, e.g. "anthropic:claude-opus-5-5"')
  .addOption(new Option("--effort <level>", "reasoning effort").choices(["low", "medium", "high", "xhigh", "max"]))
  .addOption(new Option("--permission-mode <mode>", "permission mode").choices(PERMISSION_MODES))
  .addOption(new Option("--output <format>", "headless output format").choices(["text", "json"]).default("text"))
  .option("--cwd <dir>", "project directory (default: current directory)")
  .action(async (words: string[], flags: Flags) => {
    const root = path.resolve(flags.cwd ?? process.cwd());
    const config = loadConfig(root, { model: flags.model, effort: flags.effort, permissionMode: flags.permissionMode });
    if (config.permissionMode === "bypass") {
      process.stderr.write("\x1b[33m⚠ bypass mode: every tool call runs without asking.\x1b[0m\n");
    }
    const { provider, model } = resolveModel(config.model, { anthropic: { ...config.anthropic, effort: config.effort } });

    const headless = flags.print !== undefined;
    const tty = Boolean(process.stdin.isTTY);
    // Headless: ask on stderr with readline. Interactive: the TUI's dialog.
    const rl = headless && tty ? readline.createInterface({ input: process.stdin, output: process.stderr }) : undefined;
    const bridge: AskBridge = {};
    let ask: AskFn | undefined;
    if (rl) {
      ask = async (req) => {
        const a = (await rl.question(`\n\x1b[36m? Allow ${req.tool}: ${req.summary}\x1b[0m  [y]es / [a]lways / [n]o (reason): `)).trim();
        if (/^a/i.test(a)) return { kind: "always" };
        if (/^y/i.test(a) || a === "") return { kind: "yes" };
        return { kind: "no", reason: a.replace(/^n(o)?\s*/i, "") || undefined };
      };
    } else if (!headless) {
      ask = (req) => (bridge.ask ? bridge.ask(req) : Promise.resolve({ kind: "no", reason: "UI not ready" }));
    }

    const agent = new Agent({
      provider,
      model,
      system: buildSystemPrompt({ root, cwd: root, model: config.model }),
      tools: defaultTools(),
      permissions: new Permissions(config.permissionMode, ask),
      root,
      maxTokens: config.maxTokens,
    });

    if (flags.print !== undefined) {
      const ok = await runPrompt(agent, flags.print, flags.output);
      rl?.close();
      process.exitCode = ok ? 0 : 1;
      return;
    }
    if (!tty) {
      process.stderr.write('forge: stdin is not a terminal; use -p "<prompt>" for headless mode\n');
      process.exitCode = 2;
      return;
    }
    const app = render(
      createElement(App, {
        agent,
        root,
        bridge,
        allowBypass: config.permissionMode === "bypass",
        initialPrompt: words.length ? words.join(" ") : undefined,
      }),
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
  });

/** Run one prompt; Ctrl+C aborts the turn. Returns false on error/refusal. */
async function runPrompt(agent: Agent, prompt: string, output: "text" | "json"): Promise<boolean> {
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  let ok = true;
  try {
    for await (const ev of agent.send(prompt, ac.signal)) {
      if (output === "json") process.stdout.write(JSON.stringify(ev) + "\n");
      else renderText(ev);
      if (ev.type === "done") ok = ev.stop === "end_turn";
    }
  } catch (err) {
    ok = false;
    if (output === "json") process.stdout.write(JSON.stringify({ type: "error", message: String(err) }) + "\n");
    else process.stderr.write(`\n\x1b[31merror: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (output === "text") {
    const u = agent.usage;
    process.stderr.write(`\x1b[2m[${u.inputTokens} in / ${u.outputTokens} out tokens]\x1b[0m\n`);
  }
  return ok;
}

let thinking = false;
function renderText(ev: AgentEvent): void {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  switch (ev.type) {
    case "thinking_delta":
      if (!thinking) process.stderr.write(dim("\n∴ "));
      thinking = true;
      process.stderr.write(dim(ev.text));
      break;
    case "text_delta":
      if (thinking) process.stdout.write("\n\n");
      thinking = false;
      process.stdout.write(ev.text);
      break;
    case "tool_start":
      thinking = false;
      process.stderr.write(`\n\x1b[35m● ${ev.name}\x1b[0m ${dim(ev.summary)}\n`);
      break;
    case "tool_end": {
      const text = typeof ev.result.content === "string" ? ev.result.content : "[image]";
      const preview = text.split("\n").slice(0, 4).join("\n  ");
      process.stderr.write(`  ${ev.result.isError ? "\x1b[31m" : "\x1b[2m"}${preview}${text.split("\n").length > 4 ? " …" : ""}\x1b[0m\n`);
      break;
    }
    case "retry":
      process.stderr.write(dim(`\n[stream failed (${ev.reason}); retrying ${ev.attempt}]\n`));
      break;
    case "done":
      process.stdout.write("\n");
      if (ev.stop === "refusal") process.stderr.write(`\x1b[33m[the model declined${ev.detail ? `: ${ev.detail}` : ""}]\x1b[0m\n`);
      if (ev.stop === "max_tokens") process.stderr.write("\x1b[33m[response cut off at max_tokens]\x1b[0m\n");
      if (ev.stop === "aborted") process.stderr.write("\x1b[33m[interrupted]\x1b[0m\n");
      break;
  }
}

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`forge: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
