import { z } from "zod";
import { defineTool, ToolError } from "./types.js";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  content: string;
  status: TodoStatus;
  /** Present-tense label shown while the task is in progress ("Running the tests"). */
  activeForm?: string;
}

const TodoSchema = z.object({
  content: z.string().min(1).describe('The task, imperative ("Run the tests")'),
  status: z.enum(TODO_STATUSES),
  activeForm: z.string().optional().describe('Shown while in progress ("Running the tests")'),
});

export function formatTodos(todos: Todo[]): string {
  if (!todos.length) return "(no tasks)";
  const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
  return todos.map((t, i) => `${i + 1}. ${mark[t.status]} ${t.content}`).join("\n");
}

export const todoWriteTool = defineTool({
  name: "todo_write",
  description: `Create or update your task list for the current work. The user sees it live above the prompt.
- Use it for work with 3 or more steps, or when the user gives you several things to do. Skip it for quick single-step tasks and questions.
- Send the whole list every time; it replaces the previous one.
- Exactly one task should be in_progress while you work. Mark a task completed as soon as it is done (not in batches), then set the next one to in_progress.
- Only mark a task completed when it is fully done: if tests fail or something is left over, keep it in_progress or add a task for the rest.`,
  schema: z.object({
    todos: z.array(TodoSchema).describe("The complete, updated task list"),
  }),
  // It only updates Forge's own state, so it runs freely (plan mode included).
  readOnly: true,
  summarize: (i) => {
    const done = i.todos.filter((t) => t.status === "completed").length;
    const now = i.todos.find((t) => t.status === "in_progress");
    return `${done}/${i.todos.length} done${now ? ` · ${now.activeForm ?? now.content}` : ""}`;
  },
  async run(input, ctx) {
    const active = input.todos.filter((t) => t.status === "in_progress").length;
    if (active > 1) throw new ToolError(`${active} tasks are in_progress; keep exactly one in progress at a time.`);
    const todos: Todo[] = input.todos.map((t) => ({ content: t.content.trim(), status: t.status, ...(t.activeForm ? { activeForm: t.activeForm.trim() } : {}) }));
    if (ctx.todos) ctx.todos.items = todos;
    const left = todos.filter((t) => t.status !== "completed").length;
    return {
      content: `Task list updated (${left} left):\n${formatTodos(todos)}${left === 0 && todos.length ? "\nAll tasks are done." : ""}`,
    };
  },
});

