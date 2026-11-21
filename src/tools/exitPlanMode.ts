import { z } from "zod";
import { defineTool } from "./types.js";

export const exitPlanModeTool = defineTool({
  name: "exit_plan_mode",
  description: `Present your implementation plan to the user for approval. Only use this in plan mode, after you have investigated enough to know exactly what to change.
- The plan is Markdown: the files you will change and how, in order, plus how you will verify the result. Be concrete and brief.
- If the user approves, plan mode ends and you should start implementing straight away.
- If they ask for changes, revise the plan and call this again. Don't use it to ask questions; ask those in plain text.
- Outside plan mode, don't call this: just do the task.`,
  schema: z.object({
    plan: z.string().min(1).describe("The plan, in Markdown"),
  }),
  // It changes nothing on disk, so plan mode allows it.
  readOnly: true,
  summarize: (i) => i.plan.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 80) ?? "plan",
  async run(input, ctx) {
    if (!ctx.approvePlan) return { content: "Plan approval is not available here.", isError: true };
    const d = await ctx.approvePlan(input.plan);
    if (!d.approved) return { content: d.reason, isError: true };
    return {
      content:
        d.mode === "acceptEdits"
          ? "The user approved your plan and turned on auto-accept for file edits. Start implementing it now."
          : "The user approved your plan. Start implementing it now; edits and commands will still ask for permission.",
    };
  },
});
