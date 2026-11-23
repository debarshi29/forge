import fs from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { checkFresh, recordWrite } from "./fileState.js";
import { displayPath, resolvePath } from "./paths.js";
import { notFoundMessage } from "./suggest.js";
import { defineTool, ToolError } from "./types.js";

/** Start/end offsets of each place old_string matched, and how it matched. */
export interface Located {
  spans: Array<[number, number]>;
  /** "exact", or a fallback used because the exact text wasn't in the file. */
  how: "exact" | "line-endings" | "line-numbers" | "whitespace";
  /** old_string / new_string adjusted to the file (CRLF, stripped prefixes). */
  oldStr: string;
  newStr: string;
}

function exactSpans(haystack: string, needle: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) spans.push([i, i + needle.length]);
  return spans;
}

/** "  12\tcode" → "code", when every line carries read's line-number prefix. */
function stripLineNumbers(s: string): string | undefined {
  const lines = s.split("\n");
  const numbered = lines.filter((l) => l.trim());
  if (!numbered.length || !numbered.every((l) => /^\s*\d+\t/.test(l))) return undefined;
  return lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
}

/**
 * Find old_string in the file: exactly first, then forgiving the mistakes
 * models make: \n vs \r\n, read's line-number prefixes, and different
 * whitespace (a function written on one line that spans three in the file).
 */
export function locate(before: string, oldStr: string, newStr: string): Located {
  const crlf = before.includes("\r\n");
  const toFile = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
  let spans = exactSpans(before, oldStr);
  if (spans.length) return { spans, how: "exact", oldStr, newStr };
  if (crlf && !oldStr.includes("\r\n")) {
    spans = exactSpans(before, toFile(oldStr));
    if (spans.length) return { spans, how: "line-endings", oldStr: toFile(oldStr), newStr: toFile(newStr) };
  }
  const stripped = stripLineNumbers(oldStr);
  if (stripped !== undefined) {
    const strippedNew = stripLineNumbers(newStr) ?? newStr;
    for (const candidate of [stripped, toFile(stripped)]) {
      spans = exactSpans(before, candidate);
      if (spans.length) return { spans, how: "line-numbers", oldStr: candidate, newStr: toFile(strippedNew) };
    }
  }
  const tokens = (stripped ?? oldStr).trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const re = new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
    spans = [...before.matchAll(re)].map((m) => [m.index, m.index + m[0].length] as [number, number]);
    if (spans.length) return { spans, how: "whitespace", oldStr: before.slice(spans[0]![0], spans[0]![1]), newStr: toFile(stripLineNumbers(newStr) ?? newStr) };
  }
  return { spans: [], how: "exact", oldStr, newStr };
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
    if (mtime === undefined) throw new ToolError(await notFoundMessage(ctx.root, input.path, abs));

    const before = await fs.readFile(abs, "utf8");
    const found = locate(before, input.old_string, input.new_string);
    const count = found.spans.length;
    if (count === 0) throw new ToolError(`old_string was not found in ${shown}. Read the file again and copy the text exactly.`);
    if (count > 1 && !input.replace_all) {
      throw new ToolError(
        `old_string occurs ${count} times in ${shown}; add surrounding context to make it unique, or set replace_all`,
      );
    }

    const spans = input.replace_all ? found.spans : found.spans.slice(0, 1);
    let after = before;
    // Replace from the end so earlier offsets stay valid.
    for (const [start, end] of [...spans].reverse()) after = after.slice(0, start) + found.newStr + after.slice(end);
    await ctx.checkpoint?.before(abs);
    await fs.writeFile(abs, after, "utf8");
    await recordWrite(ctx, abs);
    const note =
      found.how === "whitespace"
        ? " (old_string matched with different whitespace; check the result's formatting)"
        : found.how === "line-numbers"
          ? " (ignored the line-number prefixes in old_string)"
          : "";
    return {
      content: `Edited ${shown} (${spans.length} replacement${spans.length > 1 ? "s" : ""})${note}`,
      display: createTwoFilesPatch(shown, shown, before, after, undefined, undefined, { context: 3 }),
    };
  },
});
