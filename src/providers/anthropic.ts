import Anthropic from "@anthropic-ai/sdk";
import type {
  Block,
  Message,
  Provider,
  ProviderCapabilities,
  StopReason,
  StreamEvent,
  StreamRequest,
  ToolUseBlock,
} from "./types.js";
import { ProviderStreamError } from "./errors.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions {
  apiKey?: string;
  baseURL?: string;
  /** Opus 5.5 defaults to medium server-side, so we always send one. */
  effort?: Effort;
  /** Server-side refusal fallbacks (on by default). */
  fallbacks?: boolean;
  client?: Anthropic;
}

export const ANTHROPIC = "anthropic";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicProvider implements Provider {
  readonly name = ANTHROPIC;
  private client: Anthropic;
  private effort: Effort;
  private fallbacks: boolean;

  constructor(opts: AnthropicOptions = {}) {
    this.client =
      opts.client ??
      new Anthropic({
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
    this.effort = opts.effort ?? "high";
    this.fallbacks = opts.fallbacks ?? true;
  }

  capabilities(model: string): ProviderCapabilities {
    return {
      thinking: true,
      caching: true,
      parallelTools: true,
      contextWindow: model.startsWith("claude-haiku-4") ? 200_000 : 1_000_000,
    };
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? 64_000,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.jsonSchema as Anthropic.Beta.Messages.BetaTool.InputSchema,
        eager_input_streaming: true,
      })),
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: this.effort },
      cache_control: { type: "ephemeral" },
      stream: true,
      ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    const stream = this.client.beta.messages.stream(params, { signal: req.signal });
    const toolIdsByIndex = new Map<number, string>();
    let started = false;

    try {
      for await (const ev of stream) {
        started = true;
        if (ev.type === "content_block_start") {
          if (ev.content_block.type === "tool_use") {
            toolIdsByIndex.set(ev.index, ev.content_block.id);
            yield { type: "tool_use_start", id: ev.content_block.id, name: ev.content_block.name };
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (d.type === "text_delta") yield { type: "text_delta", text: d.text };
          else if (d.type === "thinking_delta") yield { type: "thinking_delta", text: d.thinking };
          else if (d.type === "input_json_delta") {
            const id = toolIdsByIndex.get(ev.index);
            if (id) yield { type: "tool_use_delta", id, partialJson: d.partial_json };
          }
        } else if (ev.type === "content_block_stop") {
          const id = toolIdsByIndex.get(ev.index);
          if (id) yield { type: "tool_use_end", id };
        }
      }
      const final = await stream.finalMessage();
      yield {
        type: "message_end",
        message: fromAnthropicMessage(final),
        stop: mapStop(final.stop_reason),
        usage: {
          inputTokens:
            final.usage.input_tokens +
            (final.usage.cache_read_input_tokens ?? 0) +
            (final.usage.cache_creation_input_tokens ?? 0),
          outputTokens: final.usage.output_tokens,
          cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
        },
        ...(final.stop_reason === "refusal" && final.stop_details
          ? { detail: final.stop_details.explanation ?? final.stop_details.category ?? undefined }
          : {}),
      };
    } catch (err) {
      // Typed API errors (auth, rate limit, 400...) and aborts propagate as-is;
      // the SDK has already retried what it can. A failure after the stream
      // started is a dropped connection or tool-input JSON the SDK could not
      // parse (eager input streaming): the turn can be re-issued.
      if (err instanceof Anthropic.APIError || req.signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (!started && /authentication method/i.test(message)) {
        throw new Error("No Anthropic credentials found. Set ANTHROPIC_API_KEY or run `ant auth login`.", { cause: err });
      }
      throw new ProviderStreamError(message, started, err);
    }
  }
}

function mapStop(stop: Anthropic.Beta.Messages.BetaStopReason | null): StopReason {
  switch (stop) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return "end_turn";
  }
}

export function fromAnthropicMessage(msg: Anthropic.Beta.Messages.BetaMessage): Message {
  const content: Block[] = [];
  for (const b of msg.content) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "thinking")
      content.push({ type: "thinking", provider: ANTHROPIC, text: b.thinking, payload: b });
    else content.push({ type: "thinking", provider: ANTHROPIC, payload: b });
  }
  return {
    role: "assistant",
    content,
    native: { provider: ANTHROPIC, model: msg.model, content: msg.content },
  };
}

export function toAnthropicMessages(messages: Message[]): Anthropic.Beta.Messages.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.Messages.BetaMessageParam => {
    if (m.role === "assistant" && m.native?.provider === ANTHROPIC) {
      // Preserved-thinking rule: replay our own turns byte-for-byte.
      return { role: "assistant", content: m.native.content as Anthropic.Beta.Messages.BetaContentBlockParam[] };
    }
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          if (b.text) content.push({ type: "text", text: b.text });
          break;
        case "image":
          content.push({
            type: "image",
            source: { type: "base64", media_type: b.mediaType as "image/png", data: b.data },
          });
          break;
        case "tool_use":
          content.push({ type: "tool_use", id: b.id, name: b.name, input: (b as ToolUseBlock).input as object });
          break;
        case "tool_result":
          content.push({
            type: "tool_result",
            tool_use_id: b.toolUseId,
            is_error: b.isError ?? false,
            content:
              typeof b.content === "string"
                ? b.content
                : b.content.map((c) =>
                    c.type === "text"
                      ? { type: "text" as const, text: c.text }
                      : {
                          type: "image" as const,
                          source: { type: "base64" as const, media_type: c.mediaType as "image/png", data: c.data },
                        },
                  ),
          });
          break;
        case "thinking":
          // Other providers' reasoning is meaningless here; ours is only
          // replayed through `native` above.
          break;
      }
    }
    return { role: m.role, content };
  });
}
