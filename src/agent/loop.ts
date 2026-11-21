import type { Permissions } from "../permissions/index.js";
import { ProviderStreamError } from "../providers/errors.js";
import type {
  Block,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from "../providers/types.js";
import { toToolSpec } from "../tools/registry.js";
import { costOf } from "./cost.js";
import { appendUser } from "./history.js";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "../tools/types.js";

export const MAX_TOOL_OUTPUT = 30_000;
const MAX_STREAM_RETRIES = 2;

export type AgentEvent =
  | Exclude<StreamEvent, { type: "message_end" }>
  | { type: "assistant_message"; message: Message; stop: StopReason; usage: Usage }
  | { type: "tool_start"; id: string; name: string; input: unknown; summary: string }
  | { type: "tool_end"; id: string; name: string; result: ToolResult }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "done"; stop: StopReason | "aborted"; text: string; detail?: string };

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
}

export interface Recorder {
  /** Called with exactly what was appended (user content may be merged on replay). */
  message(message: Message): void;
  usage(model: string, usage: Usage): void;
}

export class Agent {
  readonly messages: Message[];
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /** Input tokens of the most recent request: the current context size. */
  lastInputTokens = 0;
  /** Session cost in USD for models with known prices. */
  costUSD = 0;
  private readonly toolCtx: Omit<ToolContext, "signal">;

  constructor(private opts: AgentOptions) {
    this.messages = opts.messages ?? [];
    const cwd = opts.cwd ?? opts.root;
    this.toolCtx = { root: opts.root, cwd, fileState: new Map(), shell: { cwd } };
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

  get contextWindow(): number {
    return this.opts.provider.capabilities(this.opts.model).contextWindow;
  }

  get permissions(): Permissions {
    return this.opts.permissions;
  }

  get tools(): Tool[] {
    return this.opts.tools;
  }

  get recorder(): Recorder | undefined {
    return this.opts.recorder;
  }

  /** Start a fresh conversation (/clear). */
  reset(): void {
    this.messages.length = 0;
    this.toolCtx.fileState.clear();
    this.lastInputTokens = 0;
  }

  /** Replace the conversation with a saved one (/resume). */
  load(messages: Message[], totals?: { usage: Usage; costUSD: number; lastInputTokens: number }): void {
    this.reset();
    this.messages.push(...messages);
    if (totals) {
      Object.assign(this.usage, totals.usage);
      this.costUSD = totals.costUSD;
      this.lastInputTokens = totals.lastInputTokens;
    }
  }

  setRecorder(recorder: Recorder | undefined): void {
    this.opts.recorder = recorder;
  }

  /** Run one user prompt to completion, yielding events for the UI. */
  async *send(prompt: string | Block[], signal: AbortSignal = new AbortController().signal): AsyncGenerator<AgentEvent> {
    this.pushUser(typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt);
    const toolSpecs = this.opts.tools.map(toToolSpec);

    while (true) {
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
      const done = await Promise.all(batch.map((call) => this.runOne(call, signal)));
      for (const [i, result] of done.entries()) {
        const call = batch[i]!;
        results.set(call.id, toResultBlock(call.id, result));
        yield { type: "tool_end", id: call.id, name: call.name, result };
      }
    }

    // Every tool_use needs a result, including those skipped by an abort.
    return calls.map((c) => results.get(c.id) ?? errorResult(c.id, "Interrupted by the user before this tool ran."));
  }

  private async runOne(call: ToolUseBlock, signal: AbortSignal): Promise<ToolResult> {
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

    const decision = await this.opts.permissions.check(tool, parsed.data);
    if (!decision.allow) return { content: decision.reason, isError: true };
    if (signal.aborted) return { content: "Interrupted by the user.", isError: true };

    try {
      const result = await tool.run(parsed.data, { ...this.toolCtx, signal });
      return typeof result.content === "string" ? { ...result, content: truncate(result.content, MAX_TOOL_OUTPUT) } : result;
    } catch (err) {
      if (signal.aborted) return { content: "Interrupted by the user.", isError: true };
      const msg = err instanceof ToolError ? err.message : `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`;
      return { content: msg, isError: true };
    }
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

  private addUsage(u: Usage): void {
    this.costUSD += costOf(this.modelSpec, u) ?? 0;
    this.opts.recorder?.usage(this.modelSpec, u);
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
    this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    this.lastInputTokens = u.inputTokens;
  }
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
