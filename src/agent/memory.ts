import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { forgeHome } from "../config/index.js";

export const MEMORY_FILES = ["AGENTS.md", "FORGE.md"];
const MAX_CHARS = 40_000;

export interface MemoryFile {
  path: string;
  scope: "user" | "project";
  content: string;
}

/** Nearest ancestor (inclusive) containing `.git`, if any. */
export function findRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function read(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    if (!text) return undefined;
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[… truncated]` : text;
  } catch {
    return undefined;
  }
}

/**
 * Instruction files, general to specific: ~/.forge/{AGENTS,FORGE}.md, then
 * each directory from the repo root (or cwd outside a repo) down to cwd.
 */
export function loadMemory(cwd: string, env: NodeJS.ProcessEnv = process.env): MemoryFile[] {
  const out: MemoryFile[] = [];
  for (const name of MEMORY_FILES) {
    const file = path.join(forgeHome(env), name);
    const content = read(file);
    if (content) out.push({ path: file, scope: "user", content });
  }
  const top = findRepoRoot(cwd) ?? path.resolve(cwd);
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (dir === top || path.dirname(dir) === dir) break;
  }
  for (const dir of dirs) {
    for (const name of MEMORY_FILES) {
      const file = path.join(dir, name);
      const content = read(file);
      if (content) out.push({ path: file, scope: "project", content });
    }
  }
  return out;
}
