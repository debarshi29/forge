import { ApiError, GoogleGenAI, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import { ProviderStreamError } from "./errors.js";
import type { Block, Message, Provider, ProviderCapabilities, StopReason, StreamEvent, StreamRequest } from "./types.js";

export const GEMINI = "gemini";
/** Prefix for call ids we invent because Gemini returned none. */
const SYNTH = "gemini_call_";

export interface GeminiOptions {
  apiKey?: string;
  /** Use Vertex AI instead of the Gemini API. */
  vertexai?: boolean;
  project?: string;
  location?: string;
  client?: GoogleGenAI;
}

export class GeminiProvider implements Provider {
  readonly name = GEMINI;
  private opts: GeminiOptions;
  private clientInstance?: GoogleGenAI;

  constructor(opts: GeminiOptions = {}) {
    this.opts = opts;
    this.clientInstance = opts.client;
  }

  /** Created on first use, so resolving a model never fails or warns. */
  private get client(): GoogleGenAI {
    if (this.clientInstance) return this.clientInstance;
    const o = this.opts;
    if (o.vertexai) {
      this.clientInstance = new GoogleGenAI({ vertexai: true, project: o.project, location: o.location });
    } else {
      const apiKey = o.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      if (!apiKey) throw new Error("No Gemini API key. Set GEMINI_API_KEY, or set gemini.vertexai in settings to use Vertex AI.");
      this.clientInstance = new GoogleGenAI({ apiKey });
    }
    return this.clientInstance;
  }

  capabilities(): ProviderCapabilities {
    return { thinking: true, caching: false, parallelTools: true, contextWindow: 1_000_000 };
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    let started = false;
    const parts: Part[] = [];
    let finish: string | undefined;
    let blocked: string | undefined;
    let usage: GenerateContentResponse["usageMetadata"];
    const calls: Array<{ id: string; name: string; input: unknown }> = [];
    let seq = 0;

    try {
      const stream = await this.client.models.generateContentStream({
        model: req.model,
        contents: toGeminiContents(req.messages),
        config: {
          systemInstruction: req.system,
          ...(req.tools.length
            ? {
                tools: [
                  {
                    functionDeclarations: req.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: sanitizeSchema(t.jsonSchema),
                    })),
                  },
                ],
              }
            : {}),
          thinkingConfig: { includeThoughts: true },
          ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
          abortSignal: req.signal,
        },
      });
      for await (const chunk of stream) {
        started = true;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        if (chunk.promptFeedback?.blockReason) blocked = String(chunk.promptFeedback.blockReason);
        const cand = chunk.candidates?.[0];
        if (cand?.finishReason) finish = String(cand.finishReason);
        for (const part of cand?.content?.parts ?? []) {
          parts.push(part); // kept verbatim, thoughtSignature included
          if (part.text) yield part.thought ? { type: "thinking_delta", text: part.text } : { type: "text_delta", text: part.text };
          if (part.functionCall) {
            const id = part.functionCall.id ?? `${SYNTH}${Date.now().toString(36)}_${seq++}`;
            const name = part.functionCall.name ?? "";
            const input = part.functionCall.args ?? {};
            calls.push({ id, name, input });
            yield { type: "tool_use_start", id, name };
            yield { type: "tool_use_delta", id, partialJson: JSON.stringify(input) };
            yield { type: "tool_use_end", id };
          }
        }
      }
    } catch (err) {
      if (err instanceof ApiError || req.signal?.aborted) throw err;
      throw new ProviderStreamError(err instanceof Error ? err.message : String(err), started, err);
    }

    const message = fromGeminiParts(parts, calls, req.model);
    let stop: StopReason;
    if (blocked || (finish && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY/.test(finish))) stop = "refusal";
    else if (finish === "MAX_TOKENS") stop = "max_tokens";
    else stop = calls.length ? "tool_use" : "end_turn";

    yield {
      type: "message_end",
      message,
      stop,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
      },
      ...(stop === "refusal" ? { detail: blocked ?? finish } : {}),
    };
  }
}

/** Neutral view of a Gemini turn; the raw parts go in `native` for verbatim replay. */
export function fromGeminiParts(parts: Part[], calls: Array<{ id: string; name: string; input: unknown }>, model: string): Message {
  const content: Block[] = [];
  let callIdx = 0;
  for (const p of parts) {
    if (p.thought) {
      content.push({ type: "thinking", provider: GEMINI, ...(p.text ? { text: p.text } : {}), payload: p });
    } else if (p.functionCall) {
      const c = calls[callIdx++]!;
      content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    } else if (p.text) {
      const last = content.at(-1);
      if (last?.type === "text") last.text += p.text;
      else content.push({ type: "text", text: p.text });
    }
  }
  return { role: "assistant", content, native: { provider: GEMINI, model, content: { parts, callIds: calls.map((c) => c.id) } } };
}

interface GeminiNative {
  parts: Part[];
  callIds: string[];
}

export function toGeminiContents(messages: Message[]): Content[] {
  // functionResponse needs the function name; tool_result only has the id.
  const names = new Map<string, string>();
  for (const m of messages) for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);

  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.native?.provider === GEMINI) {
        out.push({ role: "model", parts: (m.native.content as GeminiNative).parts });
        continue;
      }
      // From another provider: rebuild; its reasoning can't be replayed here.
      const parts: Part[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        else if (b.type === "tool_use") {
          parts.push({
            functionCall: {
              ...(b.id.startsWith(SYNTH) ? {} : { id: b.id }),
              name: b.name,
              args: (typeof b.input === "object" && b.input !== null ? b.input : { input: b.input }) as Record<string, unknown>,
            },
          });
        }
      }
      if (parts.length) out.push({ role: "model", parts });
      continue;
    }

    const parts: Part[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const text =
          typeof b.content === "string" ? b.content : b.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
        parts.push({
          functionResponse: {
            ...(b.toolUseId.startsWith(SYNTH) ? {} : { id: b.toolUseId }),
            name: names.get(b.toolUseId) ?? "unknown",
            response: b.isError ? { error: text } : { output: text },
          },
        });
        if (typeof b.content !== "string") {
          for (const c of b.content) if (c.type === "image") parts.push({ inlineData: { mimeType: c.mediaType, data: c.data } });
        }
      } else if (b.type === "text" && b.text) parts.push({ text: b.text });
      else if (b.type === "image") parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
    }
    if (parts.length) out.push({ role: "user", parts });
  }
  return out;
}

const DROP_KEYS = new Set(["$schema", "$id", "$comment", "additionalProperties"]);

/** Remove JSON Schema keywords Gemini rejects, recursively. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      // Keys here are property names, not keywords: keep them all.
      out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, sanitizeSchema(s)]));
    } else {
      out[k] = sanitizeSchema(v);
    }
  }
  return out;
}
