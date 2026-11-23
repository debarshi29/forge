import path from "node:path";
import type { HookEvent, Hooks } from "../hooks/index.js";
import type { PermissionMode, Permissions } from "../permissions/index.js";
import { ProviderStreamError } from "../providers/errors.js";
import type {
  Block,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ToolResultBlock,
  ToolSpec,
  ToolUseBlock,
  Usage,
} from "../providers/types.js";
import { toToolSpec } from "../tools/registry.js";
import { formatTodos, type Todo } from "../tools/todo.js";
import { chooseCut, estimateMessages, estimateTokens, shrinkToolResults, summarize, summaryMessage } from "./compact.js";
import { costOf } from "./cost.js";
import { appendUser } from "./history.js";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "../tools/types.js";

export const MAX_TOOL_OUTPUT = 30_000;
const MAX_STREAM_RETRIES = 2;
/** How many times a Stop hook may send the model back to work in one prompt. */
const MAX_STOP_HOOK_CONTINUES = 3;

const PLAN_REMINDER =
  "Plan mode is on. Investigate with read-only tools only: don't edit files or run commands that change anything. When you know what to do, call exit_plan_mode with a concrete plan for the user to approve. If the request is just a question, answer it directly.";
const PLAN_ENDED = "Plan mode is off now. You may edit files and run commands (they may still ask the user for permission).";

/** Wraps text the harness adds to a user turn; the UI hides it. */
export function reminder(text: string): Block {
  return { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
}

export function isReminder(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder>");
}

export type AgentEvent =
  | Exclude<StreamEvent, { type: "message_end" }>
  | { type: "assistant_message"; message: Message; stop: StopReason; usage: Usage }
  | { type: "tool_start"; id: string; name: string; input: unknown; summary: string }
  | { type: "tool_end"; id: string; name: string; result: ToolResult }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "hook"; event: HookEvent; text: string; tone: "info" | "warn" | "error" }
  | { type: "compact"; phase: "start"; reason: "auto" | "manual"; tokens: number }
  | { type: "compact"; phase: "end"; before: number; after: number; summary: string }
  | { type: "compact"; phase: "error"; message: string }
  | { type: "todos"; todos: Todo[] }
  | { type: "done"; stop: StopReason | "aborted" | "blocked"; text: string; detail?: string };

export interface AgentOptions {
  provider: Provider;
  model: string;
  system: string;
  tools: Tool[];
  permissions: Permissions;
  root: string;
  cwd?: string;
  maxTokens?: number;
  messages?: Message[];
  /** Persistence hook (sessions): sees every appended message and usage. */
  recorder?: Recorder;
  /** User-configured shell hooks (settings "hooks"). */
  hooks?: Hooks;
  /** Summarize older turns when the context passes the threshold (default true). */
  autoCompact?: boolean;
  /** Fraction of the context window that triggers auto-compaction (default 0.8). */
  compactThreshold?: number;
}

export interface Recorder {
  /** Called with exactly what was appended (user content may be merged on replay). */
  message(message: Message): void;
  /**  marks requests that don't measure the context (summaries). */
  usage(model: string, usage: Usage, side?: boolean): void;
  /** The history was replaced by a compacted one. */
  compact?(messages: Message[]): void;
  /** The task list changed. */
  todos?(todos: Todo[]): void;
}

export class Agent {
  readonly messages: Message[];
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /** Input tokens of the most recent request: the current context size. */
  lastInputTokens = 0;
  /** Session cost in USD for models with known prices. */
  costUSD = 0;
  private readonly toolCtx: Omit<ToolContext, "signal">;
  /** Mode when the last prompt was sent, to tell the model when plan mode ends. */
  private lastPromptMode: PermissionMode | undefined;
  /** messages.length when lastInputTokens was measured. */
  private measuredAt = 0;
  private readonly todoState: { items: Todo[] } = { items: [] };

  constructor(private opts: AgentOptions) {
    this.messages = opts.messages ?? [];
    const cwd = opts.cwd ?? opts.root;
    this.toolCtx = {
      root: opts.root,
      cwd,
      fileState: new Map(),
      shell: { cwd },
      approvePlan: (plan) => this.opts.permissions.approvePlan(plan),
      todos: this.todoState,
    };
  }

  /** Model id as the provider knows it. */
  get model(): string {
    return this.opts.model;
  }

  /** "provider:model", used for display, pricing and session records. */
  get modelSpec(): string {
    return `${this.opts.provider.name}:${this.opts.model}`;
  }

  /**
   * Switch provider/model mid-session. History is kept as-is: each adapter
   * replays its own native turns and skips other providers' reasoning.
   */
  setModel(provider: Provider, model: string, system?: string): void {
    this.opts.provider = provider;
    this.opts.model = model;
    if (system !== undefined) this.opts.system = system;
  }

  get system(): string {
    return this.opts.system;
  }

  toolSpecs(): ToolSpec[] {
    return this.opts.tools.map(toToolSpec);
  }

  /** The current task list (todo_write). */
  get todos(): Todo[] {
    return this.todoState.items;
  }

  setTodos(todos: Todo[]): void {
    this.todoState.items = todos;
  }

  /**
   * Best estimate of what the next request will send: the last measured
   * input plus whatever was appended since, or a character-based estimate.
   */
  get contextTokens(): number {
    const added = estimateMessages(this.messages.slice(this.measuredAt));
    if (this.lastInputTokens > 0) return this.lastInputTokens + added;
    return estimateTokens(this.opts.system) + estimateTokens(JSON.stringify(this.toolSpecs())) + estimateMessages(this.messages);
  }

  /** Context tokens at which auto-compaction kicks in. */
  get compactAt(): number {
    return Math.floor(this.contextWindow * (this.opts.compactThreshold ?? 0.8));
  }

  get contextWindow(): number {
    return this.opts.provider.capabilities(this.opts.model).contextWindow;
  }

  get permissions(): Permissions {
    return this.opts.permissions;
  }

  get tools(): Tool[] {
    return this.opts.tools;
  }

  get hooks(): Hooks | undefined {
    return this.opts.hooks;
  }

  get recorder(): Recorder | undefined {
    return this.opts.recorder;
  }

  /** Start a fresh conversation (/clear). */
  reset(): void {
    this.messages.length = 0;
    this.toolCtx.fileState.clear();
    this.lastInputTokens = 0;
    this.measuredAt = 0;
    this.lastPromptMode = undefined;
    this.todoState.items = [];
  }

  /** Replace the conversation with a saved one (/resume). */
  load(messages: Message[], totals?: { usage: Usage; costUSD: number; lastInputTokens: number; todos?: Todo[] }): void {
    this.reset();
    this.messages.push(...messages);
    if (totals) {
      Object.assign(this.usage, totals.usage);
      this.costUSD = totals.costUSD;
      this.lastInputTokens = totals.lastInputTokens;
      this.measuredAt = totals.lastInputTokens ? messages.length : 0;
      this.todoState.items = totals.todos ?? [];
    }
  }

  /**
   * Replace older turns with a model-written summary (/compact, or
   * automatically near the context limit). Keeps recent turns verbatim.
   * On failure or abort the history is left untouched.
   */
  async *compact(opts: { focus?: string; signal?: AbortSignal; reason?: "auto" | "manual" } = {}): AsyncGenerator<AgentEvent, "skipped" | "failed" | "done"> {
    const signal = opts.signal ?? new AbortController().signal;
    const before = this.contextTokens;
    const auto = opts.reason === "auto";
    // Auto keeps recent turns up to a quarter of the window; /compact keeps only the latest reply.
    const cut = chooseCut(this.messages, auto ? Math.floor(this.contextWindow * 0.25) : 0);
    if (cut === undefined) {
      if (!auto) yield { type: "compact", phase: "error", message: "Nothing to compact yet." };
      return "skipped";
    }
    yield { type: "compact", phase: "start", reason: opts.reason ?? "manual", tokens: before };
    const old = this.messages.slice(0, cut);
    let summary: string;
    try {
      const r = await summarize({
        provider: this.opts.provider,
        model: this.opts.model,
        messages: old,
        contextWindow: this.contextWindow,
        ...(opts.focus ? { focus: opts.focus } : {}),
        signal,
      });
      summary = r.summary;
      this.addUsage(r.usage, false);
    } catch (err) {
      if (signal.aborted) {
        yield { type: "compact", phase: "error", message: "Compaction interrupted; the conversation is unchanged." };
        return "failed";
      }
      yield { type: "compact", phase: "error", message: `Compaction failed (${err instanceof Error ? err.message : String(err)}); the conversation is unchanged.` };
      return "failed";
    }
    const files = [...this.toolCtx.fileState.keys()].map((f) => displayFile(this.opts.root, f));
    const todos = this.todoState.items.length ? formatTodos(this.todoState.items) : undefined;
    // If the kept turns are still too big on their own, trim their tool output too.
    const kept = shrinkToolResults(this.messages.slice(cut), Math.floor(this.contextWindow * 0.25));
    const next = [summaryMessage(summary, { files, ...(todos ? { todos } : {}) }), ...kept];
    this.messages.length = 0;
    this.messages.push(...next);
    // File contents are gone from context: make edits read the file again first.
    this.toolCtx.fileState.clear();
    this.lastInputTokens = 0;
    this.measuredAt = 0;
    this.opts.recorder?.compact?.(next);
    yield { type: "compact", phase: "end", before, after: this.contextTokens, summary };
    return "done";
  }

  setRecorder(recorder: Recorder | undefined): void {
    this.opts.recorder = recorder;
  }

  /** Run one user prompt to completion, yielding events for the UI. */
  async *send(prompt: string | Block[], signal: AbortSignal = new AbortController().signal): AsyncGenerator<AgentEvent> {
    const blocks: Block[] = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    const extra: Block[] = [];
    if (this.opts.hooks?.has("UserPromptSubmit")) {
      const promptText = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const o = await this.opts.hooks.run({ ...this.hookBase("UserPromptSubmit"), prompt: promptText }, signal);
      yield* hookWarnings("UserPromptSubmit", o.warnings);
      if (o.block !== undefined) {
        yield { type: "hook", event: "UserPromptSubmit", text: `Prompt blocked by a hook: ${o.block}`, tone: "error" };
        yield { type: "done", stop: "blocked", text: "" };
        return;
      }
      for (const c of o.context) extra.push(reminder(`A UserPromptSubmit hook added this context:\n${c}`));
    }
    const mode = this.opts.permissions.mode;
    if (mode === "plan") extra.push(reminder(PLAN_REMINDER));
    else if (this.lastPromptMode === "plan") extra.push(reminder(PLAN_ENDED));
    this.lastPromptMode = mode;
    this.pushUser([...blocks, ...extra]);
    const toolSpecs = this.opts.tools.map(toToolSpec);
    let stopHookRuns = 0;

    let compactedThisTurn = 0;
    while (true) {
      if ((this.opts.autoCompact ?? true) && this.contextTokens >= this.compactAt && compactedThisTurn < 2 && !signal.aborted) {
        // A failed attempt counts too, so a broken summarizer isn't retried before every request.
        if ((yield* this.compact({ signal, reason: "auto" })) !== "skipped") compactedThisTurn++;
        if (signal.aborted) {
          yield { type: "done", stop: "aborted", text: "" };
          return;
        }
      }
      // --- stream one assistant turn (re-issued on retryable stream errors) ---
      let end: Extract<StreamEvent, { type: "message_end" }> | undefined;
      for (let attempt = 0; !end; attempt++) {
        try {
          for await (const ev of this.opts.provider.stream({
            model: this.opts.model,
            system: this.opts.system,
            messages: this.messages,
            tools: toolSpecs,
            maxTokens: this.opts.maxTokens,
            signal,
          })) {
            if (ev.type === "message_end") end = ev;
            else yield ev;
          }
          if (!end) throw new ProviderStreamError("stream ended without a final message", true);
        } catch (err) {
          if (signal.aborted) {
            yield { type: "done", stop: "aborted", text: "" };
            return;
          }
          if (err instanceof ProviderStreamError && err.retryable && attempt < MAX_STREAM_RETRIES) {
            yield { type: "retry", attempt: attempt + 1, reason: err.message };
            continue;
          }
          throw err;
        }
      }

      this.addUsage(end.usage);
      this.measuredAt = this.messages.length;
      this.messages.push(end.message); // verbatim, never edited afterwards
      this.opts.recorder?.message(end.message);
      yield { type: "assistant_message", message: end.message, stop: end.stop, usage: end.usage };

      const toolUses = end.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      const text = end.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      if (end.stop === "pause" && toolUses.length === 0) continue; // server asked us to resume
      if (end.stop === "refusal" || toolUses.length === 0) {
        if (end.stop !== "refusal" && this.opts.hooks?.has("Stop") && !signal.aborted) {
          const o = await this.opts.hooks.run({ ...this.hookBase("Stop"), stop_hook_active: stopHookRuns > 0 }, signal);
          yield* hookWarnings("Stop", o.warnings);
          if (o.block !== undefined && stopHookRuns < MAX_STOP_HOOK_CONTINUES && !signal.aborted) {
            stopHookRuns++;
            yield { type: "hook", event: "Stop", text: `A Stop hook sent Forge back to work: ${oneLine(o.block)}`, tone: "warn" };
            this.pushUser([reminder(`A Stop hook blocked you from finishing:\n${o.block}\nAddress this, then finish.`)]);
            continue;
          }
        }
        yield { type: "done", stop: end.stop, text, ...(end.detail ? { detail: end.detail } : {}) };
        return;
      }

      // --- run tools ---
      let results: ToolResultBlock[];
      if (end.stop === "max_tokens") {
        // A tool input cut off by max_tokens may still parse: never run it.
        results = toolUses.map((t) =>
          errorResult(t.id, "Your output hit max_tokens before this tool call finished, so it was not run. Split the work into smaller calls."),
        );
      } else {
        results = yield* this.runTools(toolUses, signal);
      }
      this.pushUser(results);
      if (signal.aborted) {
        yield { type: "done", stop: "aborted", text };
        return;
      }
    }
  }

  private async *runTools(calls: ToolUseBlock[], signal: AbortSignal): AsyncGenerator<AgentEvent, ToolResultBlock[]> {
    const results = new Map<string, ToolResultBlock>();
    // Consecutive read-only calls run in parallel; mutating calls run one at a time.
    const batches: ToolUseBlock[][] = [];
    for (const call of calls) {
      const last = batches.at(-1);
      if (last && this.isReadOnly(call) && last.every((c) => this.isReadOnly(c))) last.push(call);
      else batches.push([call]);
    }

    for (const batch of batches) {
      if (signal.aborted) break;
      const events: AgentEvent[] = [];
      for (const call of batch) {
        const tool = this.findTool(call.name);
        events.push({
          type: "tool_start",
          id: call.id,
          name: call.name,
          input: call.input,
          summary: safeSummary(tool, call.input),
        });
      }
      yield* events;
      const notices: AgentEvent[] = [];
      const done = await Promise.all(batch.map((call) => this.runOne(call, signal, notices)));
      yield* notices;
      for (const [i, result] of done.entries()) {
        const call = batch[i]!;
        results.set(call.id, toResultBlock(call.id, result));
        yield { type: "tool_end", id: call.id, name: call.name, result };
        if (call.name === "todo_write" && !result.isError) {
          this.opts.recorder?.todos?.(this.todoState.items);
          yield { type: "todos", todos: this.todoState.items };
        }
      }
    }

    // Every tool_use needs a result, including those skipped by an abort.
    return calls.map((c) => results.get(c.id) ?? errorResult(c.id, "Interrupted by the user before this tool ran."));
  }

  private async runOne(call: ToolUseBlock, signal: AbortSignal, notices: AgentEvent[]): Promise<ToolResult> {
    const tool = this.findTool(call.name);
    if (!tool) return { content: `Unknown tool "${call.name}"`, isError: true };

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      return {
        content: `Invalid input for ${call.name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}. Raw input: ${truncate(JSON.stringify(call.input), 2000)}`,
        isError: true,
      };
    }

    let input: unknown = parsed.data;
    const hooks = this.opts.hooks;
    if (hooks?.has("PreToolUse", tool.name)) {
      const o = await hooks.run({ ...this.hookBase("PreToolUse"), tool_name: tool.name, tool_input: input }, signal);
      notices.push(...hookWarnings("PreToolUse", o.warnings));
      if (o.block !== undefined) {
        notices.push({ type: "hook", event: "PreToolUse", text: `A hook blocked ${tool.name}: ${oneLine(o.block)}`, tone: "warn" });
        return { content: `Blocked by a PreToolUse hook: ${o.block}`, isError: true };
      }
      if (o.updatedInput !== undefined) {
        const re = tool.schema.safeParse(o.updatedInput);
        if (!re.success) return { content: `A PreToolUse hook returned invalid input for ${tool.name}, so it was not run.`, isError: true };
        input = re.data;
        notices.push({ type: "hook", event: "PreToolUse", text: `A hook changed the input of ${tool.name}.`, tone: "info" });
      }
    }

    const decision = await this.opts.permissions.check(tool, input);
    if (!decision.allow) return { content: decision.reason, isError: true };
    if (signal.aborted) return { content: "Interrupted by the user.", isError: true };

    let result: ToolResult;
    try {
      result = await tool.run(input, { ...this.toolCtx, signal });
      if (typeof result.content === "string") result = { ...result, content: truncate(result.content, MAX_TOOL_OUTPUT) };
    } catch (err) {
      if (signal.aborted) return { content: "Interrupted by the user.", isError: true };
      const msg = err instanceof ToolError ? err.message : `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`;
      result = { content: msg, isError: true };
    }

    if (hooks?.has("PostToolUse", tool.name) && !signal.aborted) {
      const text =
        typeof result.content === "string" ? result.content : result.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
      const o = await hooks.run(
        {
          ...this.hookBase("PostToolUse"),
          tool_name: tool.name,
          tool_input: input,
          tool_response: { content: text, is_error: Boolean(result.isError) },
        },
        signal,
      );
      notices.push(...hookWarnings("PostToolUse", o.warnings));
      const feedback = [...(o.block !== undefined ? [`PostToolUse hook feedback:\n${o.block}`] : []), ...o.context];
      if (o.block !== undefined) {
        notices.push({ type: "hook", event: "PostToolUse", text: `Hook feedback on ${tool.name}: ${oneLine(o.block)}`, tone: "warn" });
      }
      if (feedback.length) {
        const note = `<system-reminder>\n${feedback.join("\n\n")}\n</system-reminder>`;
        result =
          typeof result.content === "string"
            ? { ...result, content: `${result.content}\n\n${note}` }
            : { ...result, content: [...result.content, { type: "text", text: note }] };
      }
    }
    return result;
  }

  private hookBase(event: HookEvent) {
    return { hook_event_name: event, cwd: this.toolCtx.shell.cwd, permission_mode: this.opts.permissions.mode };
  }

  private findTool(name: string): Tool | undefined {
    return this.opts.tools.find((t) => t.name === name);
  }

  private isReadOnly(call: ToolUseBlock): boolean {
    return this.findTool(call.name)?.readOnly ?? false;
  }

  private pushUser(content: Block[]): void {
    appendUser(this.messages, content);
    this.opts.recorder?.message({ role: "user", content });
  }

  /** Count usage; `measures` = false for side requests (summaries) that don't reflect the context size. */
  private addUsage(u: Usage, measures = true): void {
    this.costUSD += costOf(this.modelSpec, u) ?? 0;
    this.opts.recorder?.usage(this.modelSpec, u, !measures);
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
    this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (measures) this.lastInputTokens = u.inputTokens;
  }
}

function displayFile(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return (rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs).split(path.sep).join("/");
}

function hookWarnings(event: HookEvent, warnings: string[]): AgentEvent[] {
  return warnings.map((text): AgentEvent => ({ type: "hook", event, text, tone: "error" }));
}

function oneLine(s: string): string {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > 200 ? `${l.slice(0, 199)}…` : l;
}

function toResultBlock(id: string, r: ToolResult): ToolResultBlock {
  return { type: "tool_result", toolUseId: id, content: r.content, ...(r.isError ? { isError: true } : {}) };
}

function errorResult(id: string, message: string): ToolResultBlock {
  return { type: "tool_result", toolUseId: id, content: message, isError: true };
}

function safeSummary(tool: Tool | undefined, input: unknown): string {
  try {
    return tool?.summarize?.(input as never) ?? truncate(JSON.stringify(input), 200);
  } catch {
    return truncate(JSON.stringify(input), 200);
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n[… output truncated: ${s.length - max} of ${s.length} characters omitted …]\n\n${s.slice(-half)}`;
}
