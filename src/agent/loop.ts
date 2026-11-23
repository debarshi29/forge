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
import { diagnosticsNote, runDiagnostics, type DiagnosticsOptions } from "./diagnostics.js";
import { repairToolInput } from "./repair.js";
import { canonicalToolName } from "../providers/toolNames.js";
import { BUILTIN_AGENTS, subagentSystem, toolsFor, type AgentType } from "./subagents.js";
import type { SubagentRequest } from "../tools/types.js";
import { appendUser } from "./history.js";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "../tools/types.js";

export const MAX_TOOL_OUTPUT = 30_000;
const MAX_STREAM_RETRIES = 2;
/** How many times one prompt may be nudged to continue after a stalled reply. */
const MAX_NUDGES = 2;
const STALL_NUDGE =
  "Your last message said what you would do next but didn't do it. If the task isn't finished, call the tool for that step now. If it is finished, say so briefly.";

/**
 * Does a reply read like it was about to act ("Let's update main.js:",
 * "Now I'll run the tests.") rather than a final answer?
 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/:\s*$/.test(t)) return true;
  const last = t.split(/\n\s*\n/).at(-1)!.trim();
  return /^(now,?\s+|next,?\s+|first,?\s+|then,?\s+)?(let's|let me|i'll|i will|i'm going to|we'll|we will|we need to)\b/i.test(last) && !/\?\s*$/.test(last);
}

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
  | { type: "notice"; text: string; tone: "info" | "warn" | "error" }
  | { type: "tool_progress"; id: string; text: string }
  | { type: "goal"; phase: "start" | "check" | "round" | "done" | "stopped"; text: string }
  | { type: "done"; stop: StopReason | "aborted" | "blocked" | "budget"; text: string; detail?: string };

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
  /** A cheaper model for side work (summaries). Defaults to the main model. */
  fast?: { provider: Provider; model: string };
  /** Check files after write/edit and feed problems back (default on; false turns it off). */
  diagnostics?: false | DiagnosticsOptions;
  /** Limits: session cost and tokens, and model requests per prompt. */
  budget?: Budget;
  /** Subagent types the task tool can start (default: the built-in ones). */
  agentTypes?: AgentType[];
  /** Resolve a "provider:model" spec for subagents with their own model. */
  resolveModel?(spec: string): Promise<{ provider: Provider; model: string }>;
  /** Remind the model to continue when a reply announces a step but calls no tool (default: local providers only). */
  nudgeStalls?: boolean;
  /** Re-ask for malformed tool arguments with schema-constrained output, where the provider supports it (default true). */
  repairToolCalls?: boolean;
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
  private readonly bg = new Map<string, BackgroundTask>();
  private bgCounter = 0;
  /** Reminders for the model (finished background agents), sent with the next request. */
  private notes: Block[] = [];
  private bgListeners = new Set<(task: BackgroundTask) => void>();

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
      runSubagent: (req, ctx) => this.runSubagent(req, ctx),
      startBackground: (job) => this.startBackground(job),
    };
  }

  /** Subagent types available to the task tool. */
  get agentTypes(): AgentType[] {
    return this.opts.agentTypes ?? BUILTIN_AGENTS;
  }

  /** Background agents started this session, oldest first. */
  get backgroundTasks(): BackgroundTask[] {
    return [...this.bg.values()];
  }

  /** Called when a background agent finishes (the UI uses it to resume). */
  onBackgroundDone(fn: (task: BackgroundTask) => void): () => void {
    this.bgListeners.add(fn);
    return () => this.bgListeners.delete(fn);
  }

  /** Stop a running background agent; false if there is none with that id. */
  stopBackground(id: string): boolean {
    const t = this.bg.get(id);
    if (!t || t.status !== "running") return false;
    t.controller.abort();
    return true;
  }

  /** Results waiting to be shown to the model. */
  get pendingNotes(): number {
    return this.notes.length;
  }

  /** Resolves when no background agent is running. */
  async waitForBackground(): Promise<void> {
    await Promise.all([...this.bg.values()].map((t) => t.done));
  }

  private takeNotes(): Block[] {
    const n = this.notes;
    this.notes = [];
    return n;
  }

  /** Run a subagent for the task tool: in the foreground (its report is the result) or the background. */
  private async runSubagent(req: SubagentRequest, ctx: ToolContext): Promise<ToolResult> {
    const type = this.agentTypes.find((t) => t.name === req.type) ?? BUILTIN_AGENTS.find((t) => t.name === "general")!;
    let model: { provider: Provider; model: string };
    try {
      model = await this.subagentModel(type);
    } catch (err) {
      return { content: `Couldn't start the ${type.name} agent: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    const child = new Agent({
      provider: model.provider,
      model: model.model,
      system: subagentSystem(this.opts.system, type),
      tools: toolsFor(type, this.opts.tools),
      permissions: this.opts.permissions,
      root: this.opts.root,
      cwd: this.toolCtx.shell.cwd,
      ...(this.opts.maxTokens ? { maxTokens: this.opts.maxTokens } : {}),
      ...(this.opts.hooks ? { hooks: this.opts.hooks } : {}),
      ...(this.opts.autoCompact !== undefined ? { autoCompact: this.opts.autoCompact } : {}),
      ...(this.opts.compactThreshold ? { compactThreshold: this.opts.compactThreshold } : {}),
      ...(this.opts.fast ? { fast: this.opts.fast } : {}),
      ...(this.opts.diagnostics !== undefined ? { diagnostics: this.opts.diagnostics } : {}),
      ...(this.opts.repairToolCalls !== undefined ? { repairToolCalls: this.opts.repairToolCalls } : {}),
      ...(this.opts.nudgeStalls !== undefined ? { nudgeStalls: this.opts.nudgeStalls } : {}),
      // Its requests count toward this session's usage, as side requests.
      recorder: { message() {}, usage: (spec, u) => this.opts.recorder?.usage(spec, u, true) },
    });
    if (!req.background) return this.driveChild(child, type, req, ctx.signal, ctx.progress);
    const id = this.startBackground({
      kind: "agent",
      type: type.name,
      description: req.description,
      run: (signal, activity) => this.driveChild(child, type, req, signal, activity),
    });
    return { content: `Started background agent ${id} (${type.name}: ${req.description}). You'll get its report when it finishes; carry on with other work meanwhile.` };
  }

  /**
   * Run a job (a subagent, a shell command) in the background. When it ends,
   * listeners hear about it and its result goes to the model with the next request.
   */
  startBackground(job: BackgroundJob): string {
    const id = `${job.kind}-${++this.bgCounter}`;
    const controller = new AbortController();
    const task: BackgroundTask = { id, kind: job.kind, type: job.type, description: job.description, status: "running", startedAt: Date.now(), controller, done: Promise.resolve() };
    const finish = (r: ToolResult) => {
      const text = typeof r.content === "string" ? r.content : "(no text)";
      task.status = controller.signal.aborted ? "stopped" : r.isError ? "failed" : "done";
      task.result = text;
      const what = job.kind === "agent" ? `agent ${id} (${job.type}: ${job.description})` : `command ${id} (${job.description})`;
      const verb = task.status === "done" ? "finished" : task.status;
      this.notes.push(reminder(`Background ${what} ${verb}. ${job.kind === "agent" ? "Its report" : "Its output"}:\n\n${text}`));
      for (const fn of this.bgListeners) fn(task);
    };
    task.done = job
      .run(controller.signal, (text) => (task.activity = text))
      .then(finish, (err: unknown) => finish({ content: err instanceof Error ? err.message : String(err), isError: true }));
    this.bg.set(id, task);
    return id;
  }

  private async subagentModel(type: AgentType): Promise<{ provider: Provider; model: string }> {
    const spec = type.model?.trim();
    if (!spec || spec === "inherit") return { provider: this.opts.provider, model: this.opts.model };
    if (spec === "fast") return this.opts.fast ?? { provider: this.opts.provider, model: this.opts.model };
    if (!this.opts.resolveModel) throw new Error(`can't resolve model "${spec}" here`);
    return this.opts.resolveModel(spec);
  }

  private async driveChild(
    child: Agent,
    type: AgentType,
    req: SubagentRequest,
    signal: AbortSignal,
    progress?: (text: string) => void,
  ): Promise<ToolResult> {
    let final = "";
    let stop: string | undefined;
    let calls = 0;
    let failure: string | undefined;
    try {
      for await (const ev of child.send(req.prompt, signal)) {
        if (ev.type === "tool_start") {
          calls++;
          progress?.(`${ev.name} ${ev.summary.split("\n")[0]}`);
        } else if (ev.type === "done") {
          final = ev.text;
          stop = ev.stop;
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    // Its tokens and cost belong to this session.
    this.usage.inputTokens += child.usage.inputTokens;
    this.usage.outputTokens += child.usage.outputTokens;
    this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + (child.usage.cacheReadTokens ?? 0);
    this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + (child.usage.cacheWriteTokens ?? 0);
    this.costUSD += child.costUSD;
    const stats = `[${type.name} agent: ${calls} tool call${calls === 1 ? "" : "s"}, ${child.usage.inputTokens + child.usage.outputTokens} tokens]`;
    if (failure) return { content: `The subagent failed: ${failure}\n${stats}`, isError: true };
    if (stop === "aborted") return { content: `The subagent was interrupted before it finished.\n${stats}`, isError: true };
    const report = final.trim() || lastAssistantText(child.messages) || "(the subagent finished without a report)";
    return { content: `${report}\n\n${stats}` };
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

  /** Use a cheaper model for summaries; undefined goes back to the main model. */
  setFastModel(fast: { provider: Provider; model: string } | undefined): void {
    this.opts.fast = fast;
  }

  /** "provider:model" of the model used for side work. */
  get fastModelSpec(): string {
    const f = this.opts.fast;
    return f ? `${f.provider.name}:${f.model}` : this.modelSpec;
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
      const side = this.opts.fast ?? { provider: this.opts.provider, model: this.opts.model };
      const r = await summarize({
        provider: side.provider,
        model: side.model,
        messages: old,
        contextWindow: this.contextWindow,
        ...(opts.focus ? { focus: opts.focus } : {}),
        signal,
      });
      summary = r.summary;
      this.addUsage(r.usage, false, `${side.provider.name}:${side.model}`);
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
    // Auto-compaction only helps if the result is smaller than what triggered it.
    if (auto && estimateMessages(next) >= estimateMessages(this.messages)) {
      yield { type: "compact", phase: "error", message: "Compacting wouldn't make the conversation smaller (the latest turns are what's big), so it is unchanged." };
      return "failed";
    }
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
    // Finished background agents' reports go with this prompt (an empty prompt just delivers them).
    const extra: Block[] = this.takeNotes();
    if (blocks.length && this.opts.hooks?.has("UserPromptSubmit")) {
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
    let stopHookRuns = 0;
    let nudges = 0;
    let requests = 0;

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
      const over = this.overBudget(requests);
      if (over) {
        yield { type: "notice", text: over, tone: "warn" };
        yield { type: "done", stop: "budget", text: "", detail: over };
        return;
      }
      requests++;
      // --- stream one assistant turn (re-issued on retryable stream errors) ---
      let end: Extract<StreamEvent, { type: "message_end" }> | undefined;
      for (let attempt = 0; !end; attempt++) {
        try {
          for await (const ev of this.opts.provider.stream({
            model: this.opts.model,
            system: this.opts.system,
            messages: this.messages,
            tools: this.requestTools(),
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
        // Small models often announce the next step ("Now let's update main.js:") and stop.
        if (end.stop === "end_turn" && this.nudgesStalls && nudges < MAX_NUDGES && looksUnfinished(text) && !signal.aborted) {
          nudges++;
          yield { type: "notice", text: "The model stopped mid-task; Forge asked it to carry on.", tone: "info" };
          this.pushUser([reminder(STALL_NUDGE)]);
          continue;
        }
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
      const extraBlocks: Block[] = [];
      if (!signal.aborted && this.opts.diagnostics !== false) {
        const changed = toolUses.flatMap((t, i) => {
          const name = this.findTool(t.name)?.name;
          const input = t.input as { path?: unknown };
          return (name === "write" || name === "edit") && !results[i]?.isError && typeof input?.path === "string"
            ? [path.resolve(this.toolCtx.cwd, input.path)]
            : [];
        });
        if (changed.length) {
          try {
            const report = await runDiagnostics(this.opts.root, changed, this.opts.diagnostics || {}, signal);
            if (report.count) {
              extraBlocks.push(reminder(diagnosticsNote(report)));
              yield { type: "notice", text: `Checks found ${report.count} problem${report.count === 1 ? "" : "s"} after the edit (${report.checks.filter((c) => report.text.includes(c)).join(", ")}); Forge will see them.`, tone: "warn" };
            }
          } catch (err) {
            if (!signal.aborted) yield { type: "notice", text: `Couldn't check the edited files: ${err instanceof Error ? err.message : String(err)}`, tone: "warn" };
          }
        }
      }
      this.pushUser([...results, ...extraBlocks, ...this.takeNotes()]);
      if (signal.aborted) {
        yield { type: "done", stop: "aborted", text };
        return;
      }
    }
  }

  private async *runTools(calls: ToolUseBlock[], signal: AbortSignal): AsyncGenerator<AgentEvent, ToolResultBlock[]> {
    const results = new Map<string, ToolResultBlock>();
    // A write or edit of a file read in this same reply is blind: the model
    // hasn't seen the contents yet (small models do this and clobber files).
    const readHere = new Set<string>();
    const blind = new Set<string>();
    for (const call of calls) {
      const name = this.findTool(call.name)?.name;
      const p = (call.input as { path?: unknown } | null)?.path;
      if (typeof p !== "string") continue;
      const abs = path.resolve(this.toolCtx.cwd, p).toLowerCase();
      if (name === "read") readHere.add(abs);
      // Edits are safe blind (old_string must match); a blind write can clobber the file.
      else if (name === "write" && readHere.has(abs)) blind.add(call.id);
    }
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
          name: tool?.name ?? call.name,
          input: call.input,
          summary: safeSummary(tool, call.input),
        });
      }
      yield* events;
      const notices: AgentEvent[] = [];
      // Progress from running tools (subagents) is yielded while they run.
      const live: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      const all = Promise.all(
        batch.map((call) =>
          blind.has(call.id)
            ? Promise.resolve<ToolResult>({
                content: `Not run: you read this file in the same reply, so you haven't seen its contents yet. Look at the read result, then make the change.`,
                isError: true,
              })
            : this.runOne(call, signal, notices, (text) => {
                live.push({ type: "tool_progress", id: call.id, text });
                wake?.();
              }),
        ),
      );
      let settled: { ok: true; value: ToolResult[] } | { ok: false; error: unknown } | undefined;
      void all.then(
        (value) => ((settled = { ok: true, value }), wake?.()),
        (error: unknown) => ((settled = { ok: false, error }), wake?.()),
      );
      while (!settled || live.length) {
        if (!live.length && !settled) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        while (live.length) yield live.shift()!;
      }
      const outcome = settled as { ok: true; value: ToolResult[] } | { ok: false; error: unknown };
      if (!outcome.ok) throw outcome.error;
      const done = outcome.value;
      yield* notices;
      for (const [i, result] of done.entries()) {
        const call = batch[i]!;
        results.set(call.id, toResultBlock(call.id, result));
        const name = this.findTool(call.name)?.name ?? call.name;
        yield { type: "tool_end", id: call.id, name, result };
        if (name === "todo_write" && !result.isError) {
          this.opts.recorder?.todos?.(this.todoState.items);
          yield { type: "todos", todos: this.todoState.items };
        }
      }
    }

    // Every tool_use needs a result, including those skipped by an abort.
    return calls.map((c) => results.get(c.id) ?? errorResult(c.id, "Interrupted by the user before this tool ran."));
  }

  private async runOne(call: ToolUseBlock, signal: AbortSignal, notices: AgentEvent[], progress?: (text: string) => void): Promise<ToolResult> {
    const tool = this.findTool(call.name);
    if (!tool) return { content: `Unknown tool "${call.name}"`, isError: true };

    let parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      // Small models often get the arguments almost right: ask again with output constrained to the schema.
      if ((this.opts.repairToolCalls ?? true) && this.opts.provider.generateJson && !signal.aborted) {
        const fixed = await repairToolInput({
          provider: this.opts.provider,
          model: this.opts.model,
          tool: toToolSpec(tool),
          input: call.input,
          errors: problems.join("\n"),
          context: this.intentContext(),
          signal,
        });
        if (fixed) {
          this.addUsage(fixed.usage, false);
          const re = tool.schema.safeParse(fixed.input);
          if (re.success) {
            parsed = re;
            notices.push({ type: "notice", text: `Fixed malformed arguments for ${tool.name}.`, tone: "info" });
          }
        }
      }
      if (!parsed.success) {
        return {
          content: `Invalid input for ${tool.name}: ${problems.join("; ")}. Raw input: ${truncate(JSON.stringify(call.input), 2000)}`,
          isError: true,
        };
      }
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
      result = await tool.run(input, { ...this.toolCtx, signal, toolUseId: call.id, ...(progress ? { progress } : {}) });
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

  /** Why the next request would break a budget, if it would. */
  private overBudget(requestsThisPrompt: number): string | undefined {
    const b = this.opts.budget;
    if (!b) return undefined;
    if (b.requestsPerPrompt !== undefined && requestsThisPrompt >= b.requestsPerPrompt) {
      return `Stopped: this prompt reached its limit of ${b.requestsPerPrompt} model requests (budget.requestsPerPrompt).`;
    }
    if (b.costUSD !== undefined && this.costUSD >= b.costUSD) return `Stopped: the session reached its cost budget of $${b.costUSD} (budget.costUSD).`;
    const tokens = this.usage.inputTokens + this.usage.outputTokens;
    if (b.tokens !== undefined && tokens >= b.tokens) return `Stopped: the session used ${tokens} tokens, its budget is ${b.tokens} (budget.tokens).`;
    return undefined;
  }

  /** Change the limits (settings, or /budget). */
  setBudget(budget: Budget | undefined): void {
    this.opts.budget = budget;
  }

  get budget(): Budget | undefined {
    return this.opts.budget;
  }

  /** Tools offered on the next request: exit_plan_mode only while plan mode is on. */
  private requestTools(): ToolSpec[] {
    const plan = this.opts.permissions.mode === "plan";
    return this.opts.tools.filter((t) => plan || t.name !== "exit_plan_mode").map(toToolSpec);
  }

  /** Local providers get nudged when they stop mid-task; cloud models don't need it. */
  private get nudgesStalls(): boolean {
    return this.opts.nudgeStalls ?? ["ollama", "lmstudio"].includes(this.opts.provider.name);
  }

  private hookBase(event: HookEvent) {
    return { hook_event_name: event, cwd: this.toolCtx.shell.cwd, permission_mode: this.opts.permissions.mode };
  }

  private findTool(name: string): Tool | undefined {
    const exact = this.opts.tools.find((t) => t.name === name);
    if (exact) return exact;
    const canonical = canonicalToolName(name, new Set(this.opts.tools.map((t) => t.name)));
    return canonical ? this.opts.tools.find((t) => t.name === canonical) : undefined;
  }

  /** The latest user request and the assistant's text since, to explain a tool call's intent. */
  private intentContext(): string {
    const parts: string[] = [];
    for (let i = this.messages.length - 1; i >= 0 && parts.length < 2; i--) {
      const m = this.messages[i]!;
      const text = m.content.flatMap((b) => (b.type === "text" && !isReminder(b.text) ? [b.text] : [])).join("\n").trim();
      if (!text) continue;
      if (m.role === "assistant" && parts.length === 0) parts.push(`Assistant: ${text}`);
      else if (m.role === "user") {
        parts.push(`User: ${text}`);
        break;
      }
    }
    return parts.reverse().join("\n\n");
  }

  private isReadOnly(call: ToolUseBlock): boolean {
    return this.findTool(call.name)?.readOnly ?? false;
  }

  private pushUser(content: Block[]): void {
    appendUser(this.messages, content);
    this.opts.recorder?.message({ role: "user", content });
  }

  /** Count usage; `measures` = false for side requests (summaries) that don't reflect the context size. */
  private addUsage(u: Usage, measures = true, spec = this.modelSpec): void {
    this.costUSD += costOf(spec, u) ?? 0;
    this.opts.recorder?.usage(spec, u, !measures);
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
    this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (measures) this.lastInputTokens = u.inputTokens;
  }
}

export interface BackgroundJob {
  kind: "agent" | "bash";
  /** Agent type, or "bash". */
  type: string;
  description: string;
  run(signal: AbortSignal, activity: (text: string) => void): Promise<ToolResult>;
}

export interface BackgroundTask {
  id: string;
  kind: "agent" | "bash";
  type: string;
  description: string;
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  /** The latest thing it did, while running. */
  activity?: string;
  /** Its report, when finished. */
  result?: string;
  controller: AbortController;
  /** Settles when it finishes. */
  done: Promise<void>;
}

export interface Budget {
  /** Stop when the session's estimated cost reaches this (USD). */
  costUSD?: number;
  /** Stop when the session's input + output tokens reach this. */
  tokens?: number;
  /** Stop a prompt after this many model requests. */
  requestsPerPrompt?: number;
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const t = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (t) return t;
  }
  return "";
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
