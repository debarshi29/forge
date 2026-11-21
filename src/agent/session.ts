import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { forgeHome } from "../config/index.js";
import type { Message, Usage } from "../providers/types.js";
import { costOf } from "./cost.js";
import { appendUser } from "./history.js";
import type { Agent, Recorder } from "./loop.js";

type Record =
  | { t: "meta"; v: 1; id: string; root: string; model: string; created: string }
  | { t: "msg"; m: Message }
  | { t: "usage"; model: string; u: Usage };

export interface SessionInfo {
  id: string;
  file: string;
  created: Date;
  updated: Date;
  model: string;
  /** First user prompt, for pickers. */
  title: string;
  messages: number;
}

export interface LoadedSession {
  info: SessionInfo;
  messages: Message[];
  usage: Usage;
  costUSD: number;
  lastInputTokens: number;
  /** Synthetic results added by repairHistory; persist them when continuing. */
  repaired?: Message;
}

export function projectDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = path.resolve(root);
  const hash = createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 12);
  const name = path.basename(resolved).replace(/[^\w.-]+/g, "_").slice(0, 40) || "root";
  return path.join(forgeHome(env), "sessions", `${name}-${hash}`);
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Append-only JSONL log of one conversation. The file is created on the first
 * message, so sessions that never start leave nothing behind.
 */
export class Session implements Recorder {
  readonly id: string;
  readonly file: string;
  private started = false;

  constructor(
    private readonly root: string,
    private model: string,
    opts: { id?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.id = opts.id ?? newId();
    this.file = path.join(projectDir(root, opts.env), `${this.id}.jsonl`);
    // Resuming an existing file: keep appending to it. A crash can leave a
    // torn last line without "\n"; terminate it so new records stay parseable.
    try {
      const text = readFileSync(this.file, "utf8");
      this.started = true;
      if (text && !text.endsWith("\n")) appendFileSync(this.file, "\n");
    } catch {
      /* new session */
    }
  }

  message(m: Message): void {
    this.write({ t: "msg", m });
  }

  usage(model: string, u: Usage): void {
    this.model = model;
    this.write({ t: "usage", model, u });
  }

  private write(rec: Record): void {
    if (!this.started) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const meta: Record = { t: "meta", v: 1, id: this.id, root: this.root, model: this.model, created: new Date().toISOString() };
      appendFileSync(this.file, JSON.stringify(meta) + "\n");
      this.started = true;
    }
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
  }
}

function parse(file: string): { meta?: Extract<Record, { t: "meta" }>; records: Record[] } {
  const records: Record[] = [];
  let meta: Extract<Record, { t: "meta" }> | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record;
      if (rec.t === "meta") meta = rec;
      else records.push(rec);
    } catch {
      // A torn final line from a crash; skip it.
    }
  }
  return { meta, records };
}

function titleOf(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.content.find((b) => b.type === "text");
    if (text?.type === "text" && text.text.trim()) return text.text.trim().replace(/\s+/g, " ").slice(0, 80);
  }
  return "(no prompt)";
}

/**
 * Make a replayed history valid: a crash mid-tool can leave tool_use blocks
 * without results, which every provider rejects.
 */
export function repairHistory(messages: Message[]): Message | undefined {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return undefined;
  const pending = last.content.filter((b) => b.type === "tool_use");
  if (!pending.length) return undefined;
  const repair: Message = {
    role: "user",
    content: pending.map((b) => ({
      type: "tool_result" as const,
      toolUseId: b.type === "tool_use" ? b.id : "",
      content: "The session ended before this tool finished.",
      isError: true,
    })),
  };
  appendUser(messages, repair.content);
  return repair;
}

export function loadSession(file: string): LoadedSession {
  const { meta, records } = parse(file);
  const messages: Message[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let costUSD = 0;
  let lastInputTokens = 0;
  let model = meta?.model ?? "unknown";
  for (const rec of records) {
    if (rec.t === "msg") {
      if (rec.m.role === "user") appendUser(messages, rec.m.content);
      else messages.push(rec.m);
    } else if (rec.t === "usage") {
      usage.inputTokens += rec.u.inputTokens;
      usage.outputTokens += rec.u.outputTokens;
      usage.cacheReadTokens! += rec.u.cacheReadTokens ?? 0;
      usage.cacheWriteTokens! += rec.u.cacheWriteTokens ?? 0;
      costUSD += costOf(rec.model, rec.u) ?? 0;
      lastInputTokens = rec.u.inputTokens;
      model = rec.model;
    }
  }
  const stat = statSync(file);
  const id = meta?.id ?? path.basename(file, ".jsonl");
  const repaired = repairHistory(messages);
  return {
    repaired,
    info: {
      id,
      file,
      created: meta ? new Date(meta.created) : stat.birthtime,
      updated: stat.mtime,
      model,
      title: titleOf(messages),
      messages: messages.length,
    },
    messages,
    usage,
    costUSD,
    lastInputTokens,
  };
}

/** Sessions for a project, most recently updated first. */
export function listSessions(root: string, env: NodeJS.ProcessEnv = process.env, limit = 50): SessionInfo[] {
  const dir = projectDir(root, env);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return files
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit)
    .flatMap((f) => {
      try {
        return [loadSession(f).info];
      } catch {
        return [];
      }
    });
}

/**
 * Load a saved session into the agent and keep appending to the same file.
 * Returns the loaded session (for rendering its transcript).
 */
export function resumeInto(
  agent: Agent,
  root: string,
  info: Pick<SessionInfo, "id" | "file">,
  env: NodeJS.ProcessEnv = process.env,
): LoadedSession {
  const loaded = loadSession(info.file);
  agent.load(loaded.messages, loaded);
  const session = new Session(root, agent.model, { id: info.id, env });
  if (loaded.repaired) session.message(loaded.repaired);
  agent.setRecorder(session);
  return loaded;
}

/** Find a session by exact id or unique id prefix. */
export function findSession(root: string, idOrPrefix: string, env: NodeJS.ProcessEnv = process.env): SessionInfo | undefined {
  const all = listSessions(root, env, 1000);
  return all.find((s) => s.id === idOrPrefix) ?? (() => {
    const matches = all.filter((s) => s.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  })();
}
