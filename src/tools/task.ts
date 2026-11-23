import { z } from "zod";
import type { AgentType } from "../agent/subagents.js";
import { defineTool, ToolError, type Tool } from "./types.js";

/**
 * The task tool: hand a self-contained job to a subagent with a fresh
 * context. Several task calls in one reply run in parallel. Its description
 * lists the available agent types, so it is built per session.
 */
export function makeTaskTool(types: AgentType[]): Tool {
  const list = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return defineTool({
    name: "task",
    description: `Start a subagent to do a self-contained task in its own fresh context, and get back only its final report. Use it to keep your context small (broad searches, reading many files) or to work on independent parts in parallel: several task calls in one reply run at the same time.

Agent types:
${list}

- The subagent can't see this conversation: put everything it needs in prompt (goal, relevant files, what to return).
- run_in_background: true returns at once; you are told when it finishes. Use it only when you have other work to do meanwhile.
- Don't use it for a single quick read or search; call that tool yourself.`,
    schema: z.object({
      description: z.string().describe("A short (3-6 word) label for the task"),
      prompt: z.string().min(1).describe("The full task for the subagent, with all the context it needs"),
      subagent_type: z.string().optional().describe(`One of: ${types.map((t) => t.name).join(", ")} (default general)`),
      run_in_background: z.boolean().optional().describe("Return immediately and get notified when it is done"),
    }),
    // Its own tools are permission-checked; read-only lets parallel task calls run together.
    readOnly: true,
    summarize: (i) => `${i.subagent_type ?? "general"}: ${i.description}`,
    async run(input, ctx) {
      if (!ctx.runSubagent) throw new ToolError("Subagents aren't available here.");
      const type = input.subagent_type ?? "general";
      if (!types.some((t) => t.name === type)) throw new ToolError(`Unknown subagent_type "${type}". Use one of: ${types.map((t) => t.name).join(", ")}`);
      return ctx.runSubagent({ type, description: input.description, prompt: input.prompt, background: input.run_in_background ?? false }, ctx);
    },
  });
}
