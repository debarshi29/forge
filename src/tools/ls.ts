import fs from "node:fs/promises";
import { z } from "zod";
import { resolvePath } from "./paths.js";
import { defineTool, ToolError } from "./types.js";

const MAX_ENTRIES = 500;

export const lsTool = defineTool({
  name: "ls",
  description: `List a directory's entries (directories end with "/"). Use glob to find files recursively.
- path may be outside the project (e.g. "C:/" or "~"); the user is asked to approve that.`,
  schema: z.object({
    path: z.string().optional().describe("Directory (default: working directory)"),
  }),
  readOnly: true,
  summarize: (i) => i.path ?? ".",
  async run(input, ctx) {
    const abs = resolvePath(ctx, input.path ?? ".", { allowOutside: true });
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      throw new ToolError(`Not a directory: ${input.path ?? "."}`);
    }
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
    if (names.length === 0) return { content: "(empty directory)" };
    const more = names.length > MAX_ENTRIES ? `\n[${names.length - MAX_ENTRIES} more]` : "";
    return { content: names.slice(0, MAX_ENTRIES).join("\n") + more };
  },
});
