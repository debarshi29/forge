/**
 * Neutral provider layer. The agent loop, tools and UI only ever see these
 * types; each adapter maps them to and from its own wire format.
 */

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  /** base64-encoded bytes */
  data: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string | Array<TextBlock | ImageBlock>;
  isError?: boolean;
}

/**
 * Provider-specific reasoning (Anthropic thinking blocks, Gemini thought
 * signatures, ...). Opaque to everything but the adapter that produced it;
 * other providers skip it when building a request.
 */
export interface ThinkingBlock {
  type: "thinking";
  provider: string;
  /** Human-readable summary, if the provider returned one. */
  text?: string;
  payload: unknown;
}

export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface Message {
  role: Role;
  content: Block[];
  /**
   * The assistant turn exactly as the provider returned it. Adapters replay it
   * verbatim when talking to the same provider, so history is never edited.
   */
  native?: { provider: string; model: string; content: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (draft 2020-12 object schema). */
  jsonSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause" | "error";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialJson: string }
  | { type: "tool_use_end"; id: string }
  | { type: "message_end"; message: Message; stop: StopReason; usage: Usage; detail?: string };

export interface StreamRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** A request whose reply must be JSON matching `schema` (structured output). */
export interface JsonRequest {
  model: string;
  system: string;
  messages: Message[];
  schema: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface JsonResult {
  value: unknown;
  usage: Usage;
}

export interface ProviderCapabilities {
  thinking: boolean;
  caching: boolean;
  parallelTools: boolean;
  contextWindow: number;
}

export interface Provider {
  readonly name: string;
  capabilities(model: string): ProviderCapabilities;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
  /** Schema-constrained JSON output, where the provider can guarantee it. */
  generateJson?(req: JsonRequest): Promise<JsonResult>;
}
