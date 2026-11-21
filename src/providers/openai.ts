import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { ProviderStreamError } from "./errors.js";
import type { Block, Message, Provider, ProviderCapabilities, StopReason, StreamEvent, StreamRequest } from "./types.js";

export interface OpenAIOptions {
  /** Provider name used in model specs and history ("openai", "ollama", ...). */
  name?: string;
  apiKey?: string;
  baseURL?: string;
  /** Context window to assume (the API doesn't report one). */
  contextWindow?: number;
  /**
   * OpenAI-compatible servers (Ollama, LM Studio, vLLM) take `max_tokens`;
   * OpenAI itself wants `max_completion_tokens`.
   */
  compat?: boolean;
  client?: OpenAI;
}

/** Chat Completions adapter: OpenAI, and anything that speaks its API. */
export class OpenAIProvider implements Provider {
  readonly name: string;
  private client: OpenAI;
  private compat: boolean;
  private contextWindow: number;

  constructor(opts: OpenAIOptions = {}) {
    this.name = opts.name ?? "openai";
    this.compat = opts.compat ?? false;
    this.contextWindow = opts.contextWindow ?? (this.compat ? 32_768 : 400_000);
    this.client =
      opts.client ??
      new OpenAI({
        apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? (this.compat ? "not-needed" : undefined),
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
  }

  capabilities(): ProviderCapabilities {
    return { thinking: false, caching: !this.compat, parallelTools: true, contextWindow: this.contextWindow };
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    const maxTokens = req.maxTokens ?? (this.compat ? 8192 : 32_000);
    const params: ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages: [{ role: "system", content: req.system }, ...toOpenAIMessages(req.messages)],
      stream: true,
      stream_options: { include_usage: true },
      ...(this.compat ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.jsonSchema },
            })),
          }
        : {}),
    };

    let started = false;
    let text = "";
    let refusal = "";
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    const calls = new Map<number, { id: string; name: string; args: string; announced: boolean }>();
    const holdback = this.compat ? new ToolCallHoldback() : undefined;

    try {
      const stream = await this.client.chat.completions.create(params, { signal: req.signal });
      for await (const chunk of stream) {
        started = true;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        if (!choice) continue;
        const d = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string };
        // Reasoning text from compatible servers (DeepSeek, Qwen on Ollama): display only.
        const reasoning = d.reasoning_content ?? d.reasoning;
        if (reasoning) yield { type: "thinking_delta", text: reasoning };
        if (d.content) {
          text += d.content;
          // On compatible servers, hold back anything that may be a text-form
          // tool call, so raw JSON never flashes up as the model's answer.
          const shown = holdback ? holdback.push(d.content) : d.content;
          if (shown) yield { type: "text_delta", text: shown };
        }
        if (d.refusal) refusal += d.refusal;
        for (const tc of d.tool_calls ?? []) {
          let call = calls.get(tc.index);
          if (!call) {
            call = { id: tc.id ?? `call_${tc.index}_${Date.now().toString(36)}`, name: "", args: "", announced: false };
            calls.set(tc.index, call);
          }
          if (tc.function?.name) call.name += tc.function.name;
          if (!call.announced && call.name) {
            call.announced = true;
            yield { type: "tool_use_start", id: call.id, name: call.name };
          }
          if (tc.function?.arguments) {
            call.args += tc.function.arguments;
            if (call.announced) yield { type: "tool_use_delta", id: call.id, partialJson: tc.function.arguments };
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      if (err instanceof OpenAI.APIError || req.signal?.aborted) throw err;
      throw new ProviderStreamError(err instanceof Error ? err.message : String(err), started, err);
    }

    const content: Block[] = [];
    if (refusal && !text) text = refusal;
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    // Small local models often write calls as JSON text instead of using
    // tool_calls. On compatible servers, turn those into real calls and keep
    // only the surrounding prose as the answer.
    if (this.compat && ordered.length === 0 && text) {
      const found = extractToolCalls(text, new Set(req.tools.map((t) => t.name)));
      if (found.calls.length) {
        text = found.rest;
        found.calls.forEach((c, i) =>
          ordered.push({ id: `call_text_${i}_${Date.now().toString(36)}`, name: c.name, args: JSON.stringify(c.args), announced: false }),
        );
      }
    }
    if (holdback) {
      const remainder = holdback.finish(text);
      if (remainder) yield { type: "text_delta", text: remainder };
    }
    if (text) content.push({ type: "text", text });
    for (const c of ordered) {
      if (!c.announced) yield { type: "tool_use_start", id: c.id, name: c.name };
      yield { type: "tool_use_end", id: c.id };
      content.push({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.args) });
    }

    let stop: StopReason;
    if (refusal || finish === "content_filter") stop = "refusal";
    else if (finish === "length") stop = "max_tokens";
    else stop = ordered.length ? "tool_use" : "end_turn";

    const message: Message = { role: "assistant", content };
    yield {
      type: "message_end",
      message,
      stop,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
      ...(refusal ? { detail: refusal } : {}),
    };
  }
}

/**
 * Recognise replies that consist solely of tool calls written as JSON
 * (`{"name": ..., "arguments": {...}}`, one per line, an array, or fenced).
 * Anything else, including prose around the JSON, is left as text.
 */
export function extractTextToolCalls(text: string, toolNames: Set<string>): Array<{ name: string; args: unknown }> {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return [];
  const candidates: unknown[] = [];
  try {
    const whole: unknown = JSON.parse(body);
    candidates.push(...(Array.isArray(whole) ? whole : [whole]));
  } catch {
    // Several values in a row: one per line, or pretty-printed back to back.
    const values = splitJsonValues(body);
    if (!values) return [];
    for (const v of values) {
      try {
        const parsed: unknown = JSON.parse(v);
        candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        return [];
      }
    }
  }
  const calls: Array<{ name: string; args: unknown }> = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") return [];
    const o = c as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof o.name !== "string" || !toolNames.has(o.name)) return [];
    let args: unknown = o.arguments ?? o.parameters ?? {};
    if (typeof args === "string") args = parseArgs(args);
    calls.push({ name: o.name, args });
  }
  return calls;
}

/** Split concatenated top-level JSON objects/arrays; undefined if anything else sits between them. */
function splitJsonValues(text: string): string[] | undefined {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      if (depth === 0) return undefined;
      inString = true;
    } else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth < 0) return undefined;
      if (depth === 0) out.push(text.slice(start, i + 1));
    } else if (depth === 0 && !/[\s,]/.test(c)) {
      return undefined;
    }
  }
  return depth === 0 && out.length ? out : undefined;
}

/**
 * Find text-form tool calls anywhere in a reply: the whole reply (see
 * extractTextToolCalls), `<tool_call>…</tool_call>` tags, fenced code blocks,
 * or lines that are a complete call object. Returns the calls and the prose
 * left after removing them. Blocks that aren't valid calls for known tools
 * stay in the prose untouched.
 */
export function extractToolCalls(text: string, toolNames: Set<string>): { calls: Array<{ name: string; args: unknown }>; rest: string } {
  const whole = extractTextToolCalls(text, toolNames);
  if (whole.length) return { calls: whole, rest: "" };

  const calls: Array<{ name: string; args: unknown }> = [];
  const take = (block: string): boolean => {
    const found = extractTextToolCalls(block, toolNames);
    if (!found.length) return false;
    calls.push(...found);
    return true;
  };
  let rest = text
    .replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, body: string) => (take(body) ? "" : m))
    .replace(/```(?:json)?\s*\n([\s\S]*?)\n?```/g, (m, body: string) => (take(body) ? "" : m))
    .replace(/^[ \t]*(\{.*\})[ \t]*$/gm, (m, line: string) => (take(line) ? "" : m));
  rest = rest.replace(/\n{3,}/g, "\n\n").trim();
  return { calls, rest };
}

/** Start of something that may turn out to be a text-form tool call. */
const CALL_MARKER = /(^|\n)[ \t]*(\{|\[\s*\{|```|<tool_call>)/;

/**
 * Streams prose immediately but holds back everything from the first
 * possible tool-call marker, until the turn ends and we know what it was.
 */
export class ToolCallHoldback {
  private text = "";
  private emitted = 0;
  private held = false;

  /** Feed a delta; returns the text that is safe to show now. */
  push(delta: string): string {
    this.text += delta;
    if (this.held) return "";
    const m = CALL_MARKER.exec(this.text.slice(this.emitted));
    let end: number;
    if (m) {
      end = this.emitted + m.index + m[1]!.length;
      this.held = true;
    } else {
      // Keep the current line back if it could still grow into a marker.
      const lineStart = this.text.lastIndexOf("\n") + 1;
      end = Math.max(this.emitted, couldBecomeMarker(this.text.slice(lineStart)) ? lineStart : this.text.length);
    }
    const out = this.text.slice(this.emitted, end);
    this.emitted = end;
    return out;
  }

  /** At the end of the turn, given the final prose, return what is still unshown. */
  finish(finalText: string): string {
    const shown = this.text.slice(0, this.emitted);
    return finalText.startsWith(shown) ? finalText.slice(shown.length) : finalText.slice(Math.min(shown.length, finalText.length));
  }
}

/** Is this (incomplete) line still a possible start of a tool-call marker? */
function couldBecomeMarker(line: string): boolean {
  const s = line.replace(/^[ \t]+/, "");
  if (s === "" || /^\[\s*$/.test(s)) return true;
  return ["```", "<tool_call>"].some((m) => m.startsWith(s));
}

/** Parse streamed arguments; invalid JSON is passed through raw so validation reports it. */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function resultText(content: Extract<Block, { type: "tool_result" }>["content"]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "[image attached in the next message]")).join("\n");
}

export function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls: ChatCompletionMessageToolCall[] = m.content.flatMap((b) =>
        b.type === "tool_use"
          ? [
              {
                id: b.id,
                type: "function" as const,
                function: { name: b.name, arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      );
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }

    // User turn: tool results become role:"tool" messages first; images from
    // tool results and the user's own content follow as one user message.
    const parts: ChatCompletionContentPart[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: (b.isError ? "Error: " : "") + resultText(b.content) });
        if (typeof b.content !== "string") {
          for (const c of b.content) {
            if (c.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${c.mediaType};base64,${c.data}` } });
          }
        }
      }
    }
    for (const b of m.content) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
    }
    if (parts.length) {
      out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n") : parts });
    }
  }
  return out;
}
