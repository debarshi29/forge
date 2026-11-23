import fs from "node:fs/promises";
import { ToolError, type ToolContext } from "./types.js";

/**
 * Guard for write/edit of an existing file: the model must have read it, and
 * it must not have changed on disk since (someone else edited it).
 * Returns the current mtime, or undefined if the file does not exist.
 */
export async function checkFresh(ctx: ToolContext, abs: string, shown: string): Promise<number | undefined> {
  let mtime: number;
  try {
    mtime = (await fs.stat(abs)).mtimeMs;
  } catch {
    return undefined;
  }
  const seen = ctx.fileState.get(abs);
  if (seen === undefined) throw new ToolError(`You must read ${shown} before changing it`);
  if (mtime > seen) throw new ToolError(`${shown} changed on disk since you last read it; read it again first`);
  return mtime;
}

export async function recordWrite(ctx: ToolContext, abs: string): Promise<void> {
  const mtime = (await fs.stat(abs)).mtimeMs;
  ctx.fileState.set(abs, mtime);
  ctx.checkpoint?.after(abs, mtime);
}
