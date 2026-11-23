import type { z } from "zod";
import type { PlanDecision } from "../permissions/index.js";
import type { ImageBlock, TextBlock } from "../providers/types.js";
import type { Todo } from "./todo.js";

export interface ToolResult {
  /** What the model sees. */
  content: string | Array<TextBlock | ImageBlock>;
  isError?: boolean;
  /** Optional richer rendering for the UI (e.g. a unified diff). */
  display?: string;
}

export interface ToolContext {
  /** Project root; file tools are confined to it. */
  root: string;
  /** Working directory for relative paths. */
  cwd: string;
  signal: AbortSignal;
  /** Absolute path -> mtimeMs at the time the model last read or wrote it. */
  fileState: Map<string, number>;
  /** Persistent shell state for the bash tool. */
  shell: { cwd: string };
  /** Show a plan to the user and leave plan mode if they approve (exit_plan_mode). */
  approvePlan?(plan: string): Promise<PlanDecision>;
  /** The agent's task list, updated by todo_write. */
  todos?: { items: Todo[] };
  /** Id of the tool call being run. */
  toolUseId?: string;
  /** Report what a long-running tool is doing (shown under its card). */
  progress?(text: string): void;
  /** Run a subagent (the task tool). */
  runSubagent?(req: SubagentRequest, ctx: ToolContext): Promise<ToolResult>;
  /** Start a background job; returns its id. Its result reaches the model when it ends. */
  startBackground?(job: {
    kind: "agent" | "bash";
    type: string;
    description: string;
    run(signal: AbortSignal, activity: (text: string) => void): Promise<ToolResult>;
  }): string;
}

export interface SubagentRequest {
  type: string;
  description: string;
  prompt: string;
  background: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** The main prompt-engineering surface: when to use it and the pitfalls. */
  description: string;
  schema: S;
  /** Read-only tools are auto-allowed and may run in parallel. */
  readOnly: boolean;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
  /** One-line summary of a call for permission prompts and tool cards. */
  summarize?(input: z.infer<S>): string;
}

/** Thrown by tools for expected failures; becomes an is_error tool_result. */
export class ToolError extends Error {
  override name = "ToolError";
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
