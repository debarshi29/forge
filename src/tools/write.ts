import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { checkFresh, recordWrite } from "./fileState.js";
import { displayPath, resolvePath } from "./paths.js";
import { defineTool } from "./types.js";

export const writeTool = defineTool({
  name: "write",
  description: `Create a file, or overwrite one completely. Parent directories are created.
- To overwrite an existing file you must have read it first in this session.
- Prefer edit for changing part of an existing file; use write for new files or full rewrites.
- Do not create documentation or other files the user did not ask for.`,
  schema: z.object({
    path: z.string().describe("File path, relative to the working directory or absolute"),
    content: z.string().describe("The complete file contents"),
  }),
  readOnly: false,
  summarize: (i) => i.path,
  async run(input, ctx) {
    const abs = resolvePath(ctx, input.path);
    const shown = displayPath(ctx.root, abs);
    const existed = (await checkFresh(ctx, abs, shown)) !== undefined;
    const before = existed ? await fs.readFile(abs, "utf8") : "";
    await ctx.checkpoint?.before(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, "utf8");
    await recordWrite(ctx, abs);
    const lines = input.content.split("\n").length;
    return {
      content: `${existed ? "Overwrote" : "Created"} ${shown} (${lines} lines)`,
      display: createTwoFilesPatch(shown, shown, before, input.content, undefined, undefined, { context: 3 }),
    };
  },
});
