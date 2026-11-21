import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { displayPath, resolvePath } from "./paths.js";
import { defineTool, ToolError } from "./types.js";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const readTool = defineTool({
  name: "read",
  description: `Read a file from the project. Returns lines prefixed with their 1-based line number and a tab ("12\\tcode").
- Reads up to ${DEFAULT_LIMIT} lines by default; use offset (1-based start line) and limit for large files.
- Lines longer than ${MAX_LINE} characters are cut.
- PNG/JPEG/GIF/WebP files are returned as images.
- You must read a file before editing or overwriting it. Read several files in parallel when you need them.
- The line-number prefix is not part of the file: never include it in edit strings.`,
  schema: z.object({
    path: z.string().describe("File path, relative to the working directory or absolute"),
    offset: z.number().int().min(1).optional().describe("1-based line to start from"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to return"),
  }),
  readOnly: true,
  summarize: (i) => i.path,
  async run(input, ctx) {
    const abs = resolvePath(ctx, input.path, { allowOutside: true });
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new ToolError(`File not found: ${input.path}`);
    }
    if (stat.isDirectory()) throw new ToolError(`${input.path} is a directory; use ls instead`);

    const mediaType = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (mediaType) {
      if (stat.size > MAX_IMAGE_BYTES) throw new ToolError(`Image is too large (${stat.size} bytes)`);
      const data = (await fs.readFile(abs)).toString("base64");
      ctx.fileState.set(abs, stat.mtimeMs);
      return { content: [{ type: "image", mediaType, data }] };
    }

    const buf = await fs.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) throw new ToolError(`${input.path} looks like a binary file`);
    ctx.fileState.set(abs, stat.mtimeMs);

    const text = buf.toString("utf8");
    if (text.length === 0) return { content: `(${displayPath(ctx.root, abs)} is empty)` };
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const start = (input.offset ?? 1) - 1;
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LIMIT));
    if (start >= lines.length) {
      throw new ToolError(`offset ${input.offset} is past the end of the file (${lines.length} lines)`);
    }
    const width = String(end).length;
    const out = lines
      .slice(start, end)
      .map((l, i) => {
        const line = l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l;
        return `${String(start + i + 1).padStart(width)}\t${line}`;
      })
      .join("\n");
    const more = end < lines.length ? `\n\n[${lines.length - end} more lines; continue with offset ${end + 1}]` : "";
    return { content: out + more };
  },
});
