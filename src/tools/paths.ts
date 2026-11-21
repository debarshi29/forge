import path from "node:path";
import { ToolError, type ToolContext } from "./types.js";

/**
 * Resolve a user/model-supplied path. Writes are confined to the project
 * root; read-only tools pass `allowOutside` because the permission layer asks
 * the user before they look outside it.
 */
export function resolvePath(ctx: Pick<ToolContext, "root" | "cwd">, p: string, opts: { allowOutside?: boolean } = {}): string {
  const abs = path.resolve(ctx.cwd, normalizeInputPath(p));
  if (!opts.allowOutside && !isInside(ctx.root, abs)) {
    throw new ToolError(`Path ${p} is outside the project root ${ctx.root}; only files inside the project can be changed.`);
  }
  return abs;
}

/**
 * On Windows, accept Git Bash style paths (/c/Users/x → C:\Users\x) and `~`.
 * Models often write these because the bash tool runs Git Bash.
 */
export function normalizeInputPath(p: string): string {
  let s = p.trim();
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) s = path.join(home, s.slice(1));
  }
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) s = `${m[1]!.toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`;
  }
  return s;
}

export function isInside(root: string, abs: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Path relative to the root (or absolute when outside it), with forward slashes, for display. */
export function displayPath(root: string, abs: string): string {
  if (!isInside(root, abs)) return abs.split(path.sep).join("/");
  const rel = path.relative(root, abs);
  return (rel || ".").split(path.sep).join("/");
}
