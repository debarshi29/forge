import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { forgeHome } from "../config/index.js";
import type { Tool } from "../tools/types.js";

/** A kind of subagent the task tool can start. */
export interface AgentType {
  name: string;
  /** When to use it; shown to the main model in the task tool's description. */
  description: string;
  /** Tool names it may use, "readonly" for every read-only tool, or "all". */
  tools: string[] | "readonly" | "all";
  /** "inherit" (default), "fast" (the fast model), or a "provider:model" spec. */
  model?: string;
  /** Instructions appended to the system prompt. */
  prompt: string;
  /** "built-in", or the file it was loaded from. */
  source: string;
}

/** Tools a subagent never gets: no nesting, and plan mode belongs to the main conversation. */
const NEVER = new Set(["task", "exit_plan_mode"]);

export const BUILTIN_AGENTS: AgentType[] = [
  {
    name: "explore",
    description:
      "Read-only search of the codebase: find where something is defined or used, how a feature works, which files matter. Say how thorough to be. Returns a report; it can't change anything.",
    tools: "readonly",
    prompt: `You are an exploration agent. Answer the question you were given by searching and reading the code: use repo_map, grep, glob, ls and read, in parallel where you can. You cannot change files or run commands.

Reply with a concise report: the answer, the relevant files as path:line, and anything surprising. Quote only the few lines that matter. Don't pad it; your report is all the caller sees.`,
    source: "built-in",
  },
  {
    name: "plan",
    description: "Read-only design work: investigate the code and return a step-by-step implementation plan with the files to change and the risks. It can't change anything.",
    tools: "readonly",
    prompt: `You are a planning agent. Investigate the code needed for the task you were given (read-only: repo_map, grep, glob, ls, read), then reply with an implementation plan:
1. The approach, in two or three sentences.
2. Numbered steps, each naming the files and functions to change.
3. Risks, open questions, and how to verify the change.

Be concrete and brief; your plan is all the caller sees.`,
    source: "built-in",
  },
  {
    name: "general",
    description: "A general-purpose agent for a self-contained multi-step task (research, edits, running commands). Its edits and commands go through the same permissions as yours.",
    tools: "all",
    prompt: `You are a subagent handling one self-contained task for the main agent. Do the whole task with your tools, verify it when you can, then reply with a short report: what you did, what you found, which files you changed, and anything left undone. Your final message is all the caller sees.`,
    source: "built-in",
  },
];

/**
 * Parse an agent file: YAML-ish frontmatter (name, description, tools,
 * model) between --- lines, then the prompt.
 */
export function parseAgentFile(text: string, source: string): AgentType {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${source}: an agent file starts with frontmatter between --- lines`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  const name = meta.name ?? path.basename(source, ".md");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`${source}: invalid agent name "${name}"`);
  if (!meta.description) throw new Error(`${source}: missing description`);
  const rawTools = (meta.tools ?? "all").replace(/^\[|\]$/g, "").trim();
  const tools: AgentType["tools"] =
    rawTools === "all" || rawTools === "*" || rawTools === "" ? "all" : rawTools === "readonly" ? "readonly" : rawTools.split(/[,\s]+/).filter(Boolean);
  return { name, description: meta.description, tools, ...(meta.model ? { model: meta.model } : {}), prompt: m[2]!.trim(), source };
}

/**
 * Built-in agents, then ~/.forge/agents/*.md, then <project>/.forge/agents/*.md.
 * A later definition with the same name replaces an earlier one.
 */
export function loadAgentTypes(root: string, env: NodeJS.ProcessEnv = process.env): { types: AgentType[]; errors: string[] } {
  const byName = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]));
  const errors: string[] = [];
  for (const dir of [path.join(forgeHome(env), "agents"), path.join(root, ".forge", "agents")]) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const t = parseAgentFile(readFileSync(file, "utf8"), file);
        byName.set(t.name, t);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { types: [...byName.values()], errors };
}

/** The tools an agent of this type gets, from the parent's. */
export function toolsFor(type: AgentType, all: Tool[]): Tool[] {
  const usable = all.filter((t) => !NEVER.has(t.name));
  if (type.tools === "all") return usable;
  if (type.tools === "readonly") return usable.filter((t) => t.readOnly && t.name !== "todo_write");
  const wanted = new Set(type.tools);
  return usable.filter((t) => wanted.has(t.name));
}

/** System prompt for a subagent: the parent's (environment, memory) plus its role. */
export function subagentSystem(parentSystem: string, type: AgentType): string {
  return `${parentSystem}

# You are a subagent (${type.name})
The main agent gave you one task. You don't see its conversation, and the user doesn't see yours: only your final message goes back, so make it complete and concise. Don't ask questions; make reasonable assumptions and say what they were.

${type.prompt}`;
}
