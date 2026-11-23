import type { Message, Provider, ToolSpec, Usage } from "../providers/types.js";

const REPAIR_SYSTEM =
  "You fix malformed tool calls for a coding agent. Given what the assistant was trying to do, the tool's description, and the arguments it wrote, reply with the corrected arguments as a JSON object that matches the tool's schema. Keep the assistant's intent and values; only fix the structure (missing or misnamed fields, wrong types, broken JSON).";

export interface RepairRequest {
  provider: Provider;
  model: string;
  tool: ToolSpec;
  /** What the model sent: parsed JSON, or the raw string if it didn't parse. */
  input: unknown;
  /** Validation errors, one per line. */
  errors: string;
  /** The user's latest request and the assistant's text this turn, for intent. */
  context: string;
  signal?: AbortSignal;
}

/**
 * Ask the model again for this tool's arguments with decoding constrained to
 * the tool's JSON schema, so the reply is valid by construction. Returns
 * undefined when the provider can't constrain output or the attempt fails.
 */
export async function repairToolInput(req: RepairRequest): Promise<{ input: unknown; usage: Usage } | undefined> {
  if (!req.provider.generateJson) return undefined;
  const raw = typeof req.input === "string" ? req.input : JSON.stringify(req.input);
  const ask = [
    req.context ? `What the assistant was doing:\n${clip(req.context, 3000)}` : "",
    `Tool: ${req.tool.name}\n${clip(req.tool.description, 1500)}`,
    `Arguments it wrote:\n${clip(raw, 6000)}`,
    `Problems:\n${req.errors}`,
    `Reply with the corrected arguments for ${req.tool.name}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: ask }] }];
  try {
    const r = await req.provider.generateJson({
      model: req.model,
      system: REPAIR_SYSTEM,
      messages,
      schema: req.tool.jsonSchema,
      maxTokens: Math.min(16_000, Math.max(1024, Math.ceil(raw.length / 2))),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    return { input: r.value, usage: r.usage };
  } catch {
    return undefined;
  }
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
