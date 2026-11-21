import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { lsTool } from "../src/tools/ls.js";
import { readTool } from "../src/tools/read.js";
import { toToolSpec, defaultTools } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import { writeTool } from "../src/tools/write.js";
import { makeCtx, tempDir, touchLater } from "./helpers.js";

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await tempDir();
  ctx = makeCtx(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.ts"), "const a = 1;\nconst b = 2;\nconst a2 = 1;\n");
});

describe("read", () => {
  it("numbers lines and honours offset/limit", async () => {
    const r = await readTool.run({ path: "src/a.ts", offset: 2, limit: 1 }, ctx);
    expect(r.content).toContain("2\tconst b = 2;");
    expect(r.content).not.toContain("const a = 1");
    expect(r.content).toContain("continue with offset 3");
  });

  it("refuses paths outside the root", async () => {
    await expect(readTool.run({ path: "../outside.txt" }, ctx)).rejects.toThrow(/outside the project root/);
  });

  it("returns images as image blocks", async () => {
    await fs.writeFile(path.join(root, "x.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await readTool.run({ path: "x.png" }, ctx);
    expect(Array.isArray(r.content) && r.content[0]?.type).toBe("image");
  });
});

describe("write", () => {
  it("creates new files with parent directories", async () => {
    await writeTool.run({ path: "deep/dir/new.txt", content: "hi" }, ctx);
    expect(await fs.readFile(path.join(root, "deep/dir/new.txt"), "utf8")).toBe("hi");
  });

  it("requires a prior read to overwrite", async () => {
    await expect(writeTool.run({ path: "src/a.ts", content: "x" }, ctx)).rejects.toThrow(/must read/);
    await readTool.run({ path: "src/a.ts" }, ctx);
    await writeTool.run({ path: "src/a.ts", content: "x" }, ctx);
    expect(await fs.readFile(path.join(root, "src/a.ts"), "utf8")).toBe("x");
  });
});

describe("edit", () => {
  it("replaces a unique string and returns a diff", async () => {
    await readTool.run({ path: "src/a.ts" }, ctx);
    const r = await editTool.run({ path: "src/a.ts", old_string: "const b = 2;", new_string: "const b = 3;" }, ctx);
    expect(await fs.readFile(path.join(root, "src/a.ts"), "utf8")).toContain("const b = 3;");
    expect(r.display).toContain("+const b = 3;");
  });

  it("rejects non-unique matches unless replace_all", async () => {
    await readTool.run({ path: "src/a.ts" }, ctx);
    await expect(editTool.run({ path: "src/a.ts", old_string: "= 1;", new_string: "= 9;" }, ctx)).rejects.toThrow(/2 times/);
    await editTool.run({ path: "src/a.ts", old_string: "= 1;", new_string: "= 9;", replace_all: true }, ctx);
    expect((await fs.readFile(path.join(root, "src/a.ts"), "utf8")).match(/= 9;/g)).toHaveLength(2);
  });

  it("rejects edits to files changed since they were read", async () => {
    await readTool.run({ path: "src/a.ts" }, ctx);
    await touchLater(path.join(root, "src/a.ts"));
    await expect(editTool.run({ path: "src/a.ts", old_string: "const b", new_string: "let b" }, ctx)).rejects.toThrow(/changed on disk/);
  });

  it("requires a prior read", async () => {
    await expect(editTool.run({ path: "src/a.ts", old_string: "const b", new_string: "let b" }, ctx)).rejects.toThrow(/must read/);
  });

  it("matches LF edit strings against CRLF files", async () => {
    await fs.writeFile(path.join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
    await readTool.run({ path: "crlf.txt" }, ctx);
    await editTool.run({ path: "crlf.txt", old_string: "one\ntwo", new_string: "1\n2" }, ctx);
    expect(await fs.readFile(path.join(root, "crlf.txt"), "utf8")).toBe("1\r\n2\r\nthree\r\n");
  });
});

describe("glob / grep / ls", () => {
  it("globs relative paths", async () => {
    const r = await globTool.run({ pattern: "**/*.ts" }, ctx);
    expect(r.content).toBe("src/a.ts");
  });

  it("greps content with line numbers", async () => {
    const r = await grepTool.run({ pattern: "const b", output_mode: "content" }, ctx);
    expect(r.content).toBe("src/a.ts:2:const b = 2;");
    const files = await grepTool.run({ pattern: "const" }, ctx);
    expect(files.content).toBe("src/a.ts");
    const none = await grepTool.run({ pattern: "nope_nothing" }, ctx);
    expect(none.content).toBe("No matches found");
  });

  it("lists directories first", async () => {
    await fs.writeFile(path.join(root, "z.txt"), "");
    const r = await lsTool.run({}, ctx);
    expect(r.content).toBe("src/\nz.txt");
  });
});

describe("bash", () => {
  it("runs commands and reports exit codes", async () => {
    const ok = await bashTool.run({ command: "echo hello" }, ctx);
    expect(ok.content).toContain("hello");
    expect(ok.isError).toBeFalsy();
    const bad = await bashTool.run({ command: "exit 3" }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("exit code 3");
  });

  it("persists cwd between calls", async () => {
    await bashTool.run({ command: "cd src" }, ctx);
    expect(path.resolve(ctx.shell.cwd)).toBe(path.join(root, "src"));
    const r = await bashTool.run({ command: "ls" }, ctx);
    expect(r.content).toContain("a.ts");
  });

  it("times out", async () => {
    const r = await bashTool.run({ command: "sleep 5", timeout_ms: 1000 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timed out");
  }, 10_000);

  it("aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await bashTool.run({ command: "sleep 5" }, { ...ctx, signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("interrupted");
  }, 10_000);
});

describe("tool specs", () => {
  it("produce object JSON schemas without $schema", () => {
    for (const t of defaultTools()) {
      const spec = toToolSpec(t);
      expect(spec.jsonSchema.type).toBe("object");
      expect(spec.jsonSchema.$schema).toBeUndefined();
    }
  });
});
