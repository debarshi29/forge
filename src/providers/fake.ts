import type { Message, Provider, ProviderCapabilities, StopReason, StreamEvent, StreamRequest, Usage } from "./types.js";

/** One scripted assistant turn. */
export interface FakeTurn {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ id?: string; name: string; input: unknown }>;
  stop?: StopReason;
  usage?: Partial<Usage>;
  /** Throw this instead of streaming. */
  error?: Error;
  /** Wait for this many ms (abortable) before finishing. */
  delayMs?: number;
}

/**
 * Replays scripted turns, for deterministic end-to-end loop tests. Records
 * every request it receives in `requests`.
 */
export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly requests: StreamRequest[] = [];
  private turn = 0;

  constructor(private readonly turns: FakeTurn[]) {}

  capabilities(): ProviderCapabilities {
    return { thinking: false, caching: false, parallelTools: true, contextWindow: 100_000 };
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const t = this.turns[this.turn++];
    if (!t) throw new Error(`FakeProvider: no scripted turn #${this.turn}`);
    if (t.error) throw t.error;

    const content: Message["content"] = [];
    if (t.thinking) {
      yield { type: "thinking_delta", text: t.thinking };
      content.push({ type: "thinking", provider: "fake", text: t.thinking, payload: t.thinking });
    }
    if (t.text) {
      for (const chunk of t.text.match(/.{1,8}/gs) ?? []) yield { type: "text_delta", text: chunk };
      content.push({ type: "text", text: t.text });
    }
    let n = 0;
    for (const call of t.toolCalls ?? []) {
      const id = call.id ?? `call_${this.turn}_${n++}`;
      yield { type: "tool_use_start", id, name: call.name };
      yield { type: "tool_use_delta", id, partialJson: JSON.stringify(call.input) };
      yield { type: "tool_use_end", id };
      content.push({ type: "tool_use", id, name: call.name, input: call.input });
    }
    if (t.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, t.delayMs);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    yield {
      type: "message_end",
      message: { role: "assistant", content },
      stop: t.stop ?? (t.toolCalls?.length ? "tool_use" : "end_turn"),
      usage: { inputTokens: 10, outputTokens: 5, ...t.usage },
    };
  }
}
