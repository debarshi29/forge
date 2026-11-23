import { z } from "zod";
import type { ToolSpec } from "../providers/types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { exitPlanModeTool } from "./exitPlanMode.js";
import { todoWriteTool } from "./todo.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { repoMapTool } from "./repoMap.js";
import { webFetchTool } from "./webFetch.js";
import type { Tool } from "./types.js";
import { writeTool } from "./write.js";

export function defaultTools(): Tool[] {
  return [readTool, writeTool, editTool, globTool, grepTool, lsTool, repoMapTool, bashTool, webFetchTool, todoWriteTool, exitPlanModeTool] as Tool[];
}

export function toToolSpec(tool: Tool): ToolSpec {
  if (tool.jsonSchema) return { name: tool.name, description: tool.description, jsonSchema: tool.jsonSchema };
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, jsonSchema };
}
