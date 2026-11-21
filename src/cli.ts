#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import { render } from "ink";
import { createElement } from "react";
import { Agent, type AgentEvent } from "./agent/loop.js";
import { formatCost } from "./agent/cost.js";
import { loadMemory } from "./agent/memory.js";
import { findSession, listSessions, resumeInto, Session } from "./agent/session.js";
import { buildSystemPrompt } from "./agent/systemPrompt.js";
import { messagesToItems } from "./ui/history.js";
import { loadConfig, saveUserSettings } from "./config/index.js";
import { DEFAULT_THEME, findTheme } from "./ui/theme.js";
import { PERMISSION_MODES, Permissions, type AskFn, type PermissionMode } from "./permissions/index.js";
import { Hooks } from "./hooks/index.js";
import { listModelOptions, resolveModelForUse } from "./providers/catalog.js";
import type { ProviderSettings } from "./providers/registry.js";
import { defaultTools } from "./tools/registry.js";
import { App, type AskBridge, type PetSettings } from "./ui/App.js";
import { filterMouse } from "./ui/mouseStdin.js";
import { MOUSE_OFF } from "./ui/pets.js";

interface Flags {
  print?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: PermissionMode;
  output: "text" | "json";
  cwd?: string;
  continue?: boolean;
  resume?: string | boolean;
  session?: boolean;
}

const program = new Command()
  .name("forge")
  .version(packageVersion(), "-v, --version")
  .description("A provider-agnostic terminal coding agent")
  .argument("[prompt...]", "prompt for interactive mode")
  .option("-p, --print <prompt>", "run one prompt headlessly and print the result")
  .option("-m, --model <model>", 'provider:model, e.g. "anthropic:claude-opus-5-5" (default: an installed Ollama model)')
  .addOption(new Option("--effort <level>", "reasoning effort").choices(["low", "medium", "high", "xhigh", "max"]))
  .addOption(new Option("--permission-mode <mode>", "permission mode").choices(PERMISSION_MODES))
  .addOption(new Option("--output <format>", "headless output format").choices(["text", "json"]).default("text"))
  .option("--cwd <dir>", "project directory (default: current directory)")
  .option("-c, --continue", "continue the most recent session in this project")
  .option("-r, --resume [id]", "resume a session by id (or pick one interactively)")
  .option("--no-session", "don't save this conversation")
  .action(async (words: string[], flags: Flags) => {
    const root = path.resolve(flags.cwd ?? process.cwd());
    const config = loadConfig(root, { model: flags.model, effort: flags.effort, permissionMode: flags.permissionMode });
    if (config.permissionMode === "bypass") {
      process.stderr.write("\x1b[33m⚠ bypass mode: every tool call runs without asking.\x1b[0m\n");
    }
    const providerSettings: ProviderSettings = {
      anthropic: { ...config.anthropic, effort: config.effort },
      openai: config.openai,
      gemini: config.gemini,
      ollama: config.ollama,
      lmstudio: config.lmstudio,
    };
    const resolved = await resolveModelForUse(config.model, providerSettings);
    const { provider, model } = resolved;

    const headless = flags.print !== undefined;
    const tty = Boolean(process.stdin.isTTY);
    // Headless: ask on stderr with readline. Interactive: the TUI's dialog.
    const rl = headless && tty ? readline.createInterface({ input: process.stdin, output: process.stderr }) : undefined;
    const bridge: AskBridge = {};
    let ask: AskFn | undefined;
    if (rl) {
      ask = async (req) => {
        if (req.kind === "plan") {
          process.stderr.write(`\n\x1b[36m── Forge's plan ──\x1b[0m\n${req.summary}\n`);
          const a = (await rl.question("\x1b[36m? Approve? [y]es / [a]uto-accept edits / [n]o (what to change): \x1b[0m")).trim();
          if (/^a/i.test(a)) return { kind: "always" };
          if (/^y/i.test(a) || a === "") return { kind: "yes" };
          return { kind: "no", reason: a.replace(/^n(o)?\s*/i, "") || undefined };
        }
        if (req.warning) process.stderr.write(`\n\x1b[31m⚠ ${req.warning}\x1b[0m`);
        const always = req.allowAlways === false ? "" : " / [a]lways";
        const a = (await rl.question(`\n\x1b[36m? Allow ${req.tool}: ${req.summary}\x1b[0m  [y]es${always} / [n]o (reason): `)).trim();
        if (/^a/i.test(a) && req.allowAlways !== false) return { kind: "always" };
        if (/^y/i.test(a) || a === "") return { kind: "yes" };
        return { kind: "no", reason: a.replace(/^n(o)?\s*/i, "") || undefined };
      };
    } else if (!headless) {
      ask = (req) => (bridge.ask ? bridge.ask(req) : Promise.resolve({ kind: "no", reason: "UI not ready" }));
    }

    const memory = loadMemory(root);
    const tools = defaultTools();
    const agent = new Agent({
      provider,
      model,
      system: buildSystemPrompt({ root, cwd: root, model: resolved.spec, memory }),
      tools,
      permissions: new Permissions(config.permissionMode, ask, { rules: config.permissions, root }),
      root,
      maxTokens: config.maxTokens,
      hooks: new Hooks(config.hooks, root),
    });

    // Sessions: --continue (latest), --resume <id>, or --resume alone (picker).
    let initialItems: ReturnType<typeof messagesToItems> | undefined;
    let pickSession = false;
    if (flags.session !== false) {
      const target =
        flags.continue === true
          ? listSessions(root)[0]
          : typeof flags.resume === "string"
            ? findSession(root, flags.resume)
            : undefined;
      if ((flags.continue || typeof flags.resume === "string") && !target) {
        throw new Error(flags.continue ? "No previous session for this project." : `No session matches "${flags.resume}".`);
      }
      if (target) {
        const loaded = resumeInto(agent, root, target);
        initialItems = [
          ...messagesToItems(loaded.messages, tools),
          { kind: "info", text: `Resumed session ${target.id} (${loaded.messages.length} messages).` },
        ];
        if (headless && flags.output === "text") process.stderr.write(`\x1b[2m[resumed ${target.id}]\x1b[0m\n`);
      } else {
        agent.setRecorder(new Session(root, resolved.spec));
        pickSession = flags.resume === true;
        if (pickSession && headless) throw new Error("--resume needs a session id in -p mode (or use --continue)");
      }
    }

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
    // Ink drops mouse reports, so clicks for the pet are filtered out of stdin first.
    const input = filterMouse(process.stdin);
    const app = render(
      createElement(App, {
        agent,
        root,
        bridge,
        allowBypass: config.permissionMode === "bypass",
        initialPrompt: words.length ? words.join(" ") : undefined,
        initialItems,
        pickSession,
        memory,
        switchModel: async (spec: string) => {
          const next = await resolveModelForUse(spec, providerSettings);
          agent.setModel(next.provider, next.model, buildSystemPrompt({ root, cwd: root, model: next.spec, memory }));
        },
        listModels: () => listModelOptions(providerSettings),
        initialTheme: findTheme(config.theme) ?? DEFAULT_THEME,
        mouse: input.mouse,
        initialPet: { kind: config.pet ?? "none", name: config.petName, clicks: config.petMouse ?? false },
        savePet: (pet: PetSettings) => {
          try {
            saveUserSettings({ pet: pet.kind, ...(pet.name ? { petName: pet.name } : {}), petMouse: pet.clicks });
          } catch {
            // Not fatal.
          }
        },
        saveTheme: (name: string) => {
          try {
            saveUserSettings({ theme: name });
          } catch {
            // Not fatal: the theme still applies for this session.
          }
        },
      }),
      { exitOnCtrlC: false, stdin: input.stdin },
    );
    // Never leave the terminal in mouse-reporting mode, however we exit.
    process.once("exit", () => process.stdout.write(MOUSE_OFF));
    await app.waitUntilExit();
    input.dispose();
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
    process.stderr.write(`\x1b[2m[${u.inputTokens} in / ${u.outputTokens} out tokens · ${formatCost(agent.costUSD)}]\x1b[0m\n`);
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
    case "hook":
      process.stderr.write(`\n${ev.tone === "error" ? "\x1b[31m" : ev.tone === "warn" ? "\x1b[33m" : "\x1b[2m"}[hook] ${ev.text}\x1b[0m\n`);
      break;
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

/** Version from package.json, found next to dist/ (built) or src/ (dev). */
function packageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`forge: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
