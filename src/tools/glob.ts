import fg from "fast-glob";
import { z } from "zod";
import { displayPath, resolvePath } from "./paths.js";
import { defineTool } from "./types.js";

const MAX_RESULTS = 200;

export const globTool = defineTool({
  name: "glob",
  description: `Find files by glob pattern (e.g. "src/**/*.ts", "**/package.json"). Returns paths sorted by most recently modified.
- node_modules and .git are skipped.
- Use grep to search file contents instead.`,
  schema: z.object({
    pattern: z.string().describe("Glob pattern"),
    path: z.string().optional().describe("Directory to search in (default: working directory)"),
  }),
  readOnly: true,
  summarize: (i) => (i.path ? `${i.pattern} in ${i.path}` : i.pattern),
  async run(input, ctx) {
    const dir = resolvePath(ctx, input.path ?? ".", { allowOutside: true });
    const entries = await fg(input.pattern, {
      cwd: dir,
      absolute: true,
      onlyFiles: true,
      dot: true,
      stats: true,
      suppressErrors: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    if (entries.length === 0) return { content: "No files found" };
    entries.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    const shown = entries.slice(0, MAX_RESULTS).map((e) => displayPath(ctx.root, e.path));
    const more = entries.length > MAX_RESULTS ? `\n[${entries.length - MAX_RESULTS} more; narrow the pattern]` : "";
    return { content: shown.join("\n") + more };
  },
});
