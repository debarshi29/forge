import path from "node:path";
import { ToolError, type ToolContext } from "./types.js";

/** Resolve a user/model-supplied path and confine it to the project root. */
export function resolvePath(ctx: Pick<ToolContext, "root" | "cwd">, p: string): string {
  const abs = path.resolve(ctx.cwd, p);
  if (!isInside(ctx.root, abs)) {
    throw new ToolError(`Path ${p} is outside the project root ${ctx.root}`);
  }
  return abs;
}

export function isInside(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Path relative to the root, with forward slashes, for display. */
export function displayPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return (rel || ".").split(path.sep).join("/");
}
