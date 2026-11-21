import fs from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { checkFresh, recordWrite } from "./fileState.js";
import { displayPath, resolvePath } from "./paths.js";
import { defineTool, ToolError } from "./types.js";

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

export const editTool = defineTool({
  name: "edit",
  description: `Replace an exact string in a file.
- You must read the file first. old_string must match the file exactly, including whitespace and indentation, and must not include the line-number prefix that read shows.
- old_string must occur exactly once unless replace_all is true; if it is not unique, include more surrounding lines.
- Use replace_all to rename something throughout the file.
- To create a file, use write instead.`,
  schema: z.object({
    path: z.string().describe("File path, relative to the working directory or absolute"),
    old_string: z.string().min(1).describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text (must differ from old_string)"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  }),
  readOnly: false,
  summarize: (i) => i.path,
  async run(input, ctx) {
    const abs = resolvePath(ctx, input.path);
    const shown = displayPath(ctx.root, abs);
    if (input.old_string === input.new_string) throw new ToolError("old_string and new_string are identical");
    const mtime = await checkFresh(ctx, abs, shown);
    if (mtime === undefined) throw new ToolError(`File not found: ${input.path}`);

    const before = await fs.readFile(abs, "utf8");
    let oldStr = input.old_string;
    let newStr = input.new_string;
    let count = countOccurrences(before, oldStr);
    // Models write "\n"; files on Windows often use "\r\n".
    if (count === 0 && before.includes("\r\n") && !oldStr.includes("\r\n")) {
      oldStr = oldStr.replace(/\n/g, "\r\n");
      newStr = newStr.replace(/\r?\n/g, "\r\n");
      count = countOccurrences(before, oldStr);
    }
    if (count === 0) throw new ToolError(`old_string was not found in ${shown}`);
    if (count > 1 && !input.replace_all) {
      throw new ToolError(
        `old_string occurs ${count} times in ${shown}; add surrounding context to make it unique, or set replace_all`,
      );
    }

    const after = input.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, () => newStr);
    await fs.writeFile(abs, after, "utf8");
    await recordWrite(ctx, abs);
    return {
      content: `Edited ${shown} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? "s" : ""})`,
      display: createTwoFilesPatch(shown, shown, before, after, undefined, undefined, { context: 3 }),
    };
  },
});
