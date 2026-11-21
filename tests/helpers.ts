import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/tools/types.js";

export async function tempDir(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "forge-test-")));
}

export function makeCtx(root: string, signal = new AbortController().signal): ToolContext {
  return { root, cwd: root, signal, fileState: new Map(), shell: { cwd: root } };
}

/** Bump a file's mtime as if someone edited it outside the agent. */
export async function touchLater(file: string): Promise<void> {
  const future = new Date(Date.now() + 5000);
  await fs.utimes(file, future, future);
}
