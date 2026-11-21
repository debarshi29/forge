import { z } from "zod";
import type { ToolSpec } from "../providers/types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { exitPlanModeTool } from "./exitPlanMode.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import type { Tool } from "./types.js";
import { writeTool } from "./write.js";

export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, globTool, grepTool, lsTool, bashTool, exitPlanModeTool] as Tool[];
}

export function toToolSpec(tool: Tool): ToolSpec {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, jsonSchema };
}
