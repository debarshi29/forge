import path from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { execa } from "execa";
import { z } from "zod";
import { resolvePath } from "./paths.js";
import { defineTool, ToolError } from "./types.js";

const DEFAULT_HEAD = 250;

export const grepTool = defineTool({
  name: "grep",
  description: `Search file contents with ripgrep (Rust regex syntax: escape literal braces, e.g. "interface\\{\\}").
- output_mode: "files_with_matches" (default, paths only), "content" (matching lines with line numbers), or "count".
- Filter files with glob (e.g. "*.ts") or type (e.g. "py"). Respects .gitignore.
- Results are capped by head_limit (default ${DEFAULT_HEAD} lines).`,
  schema: z.object({
    pattern: z.string().describe("Regular expression"),
    path: z.string().optional().describe("File or directory to search (default: working directory)"),
    glob: z.string().optional().describe('Glob filter, e.g. "*.{ts,tsx}"'),
    type: z.string().optional().describe('ripgrep file type, e.g. "js"'),
    output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    case_insensitive: z.boolean().optional(),
    context: z.number().int().min(0).max(20).optional().describe("Lines of context around matches (content mode)"),
    multiline: z.boolean().optional().describe("Let patterns span lines"),
    head_limit: z.number().int().min(1).optional(),
  }),
  readOnly: true,
  summarize: (i) => (i.path ? `"${i.pattern}" in ${i.path}` : `"${i.pattern}"`),
  async run(input, ctx) {
    const target = resolvePath(ctx, input.path ?? ".");
    const mode = input.output_mode ?? "files_with_matches";
    const args = ["--color=never", "--no-messages", "--hidden", "--glob=!.git"];
    if (mode === "files_with_matches") args.push("--files-with-matches");
    else if (mode === "count") args.push("--count");
    else args.push("--line-number", "--no-heading", "--max-columns=500");
    if (input.case_insensitive) args.push("-i");
    if (input.multiline) args.push("-U", "--multiline-dotall");
    if (input.context && mode === "content") args.push(`-C${input.context}`);
    if (input.glob) args.push(`--glob=${input.glob}`);
    if (input.type) args.push(`--type=${input.type}`);
    // Search a root-relative path so output paths come back relative.
    args.push("--regexp", input.pattern, path.relative(ctx.root, target) || ".");

    const r = await execa(rgPath, args, { cwd: ctx.root, reject: false, cancelSignal: ctx.signal, maxBuffer: 50_000_000 });
    if (r.exitCode === 1) return { content: "No matches found" };
    if (r.exitCode !== 0) throw new ToolError(`ripgrep failed: ${r.stderr || r.stdout}`);

    // Normalise Windows separators in the path part only, never in matched text.
    const lines = r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const i = mode === "files_with_matches" ? l.length : l.search(/[:-]\d+[:-]|:\d+$/);
        const cut = i === -1 ? l.length : i;
        return l.slice(0, cut).replace(/\\/g, "/").replace(/^\.\//, "") + l.slice(cut);
      });
    const limit = input.head_limit ?? DEFAULT_HEAD;
    const more = lines.length > limit ? `\n[${lines.length - limit} more lines; narrow the search or raise head_limit]` : "";
    return { content: lines.slice(0, limit).join("\n") + more };
  },
});
