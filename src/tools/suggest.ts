import path from "node:path";
import { listProjectFiles } from "./repoMap.js";
import { displayPath } from "./paths.js";

/**
 * Paths in the project that look like what a model meant when it asked for a
 * file that doesn't exist: the same file name elsewhere, or files under a
 * directory named like it ("server.js" → src/server/app.js). Small models
 * often guess paths; pointing at real ones saves several wasted turns.
 */
export async function similarPaths(root: string, missingAbs: string, limit = 5): Promise<string[]> {
  const base = path.basename(missingAbs).toLowerCase();
  const stem = base.replace(/\.[^.]+$/, "");
  if (!stem) return [];
  let files: string[];
  try {
    files = await listProjectFiles(root);
  } catch {
    return [];
  }
  const scored: Array<{ file: string; score: number }> = [];
  for (const f of files) {
    const parts = f.toLowerCase().split("/");
    const name = parts.at(-1)!;
    const nameStem = name.replace(/\.[^.]+$/, "");
    let score = 0;
    if (name === base) score = 4;
    else if (nameStem === stem) score = 3;
    else if (parts.slice(0, -1).includes(stem)) score = 2;
    else if (stem.length >= 3 && (nameStem.includes(stem) || (nameStem.length >= 3 && stem.includes(nameStem)))) score = 1;
    if (score) scored.push({ file: f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => displayPath(root, path.join(root, s.file)));
}

/** "File not found: x" plus suggestions, for read and edit. */
export async function notFoundMessage(root: string, requested: string, abs: string): Promise<string> {
  const rel = path.relative(root, abs);
  const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  const similar = inside ? await similarPaths(root, abs) : [];
  if (similar.length) return `File not found: ${requested}. Files with similar names: ${similar.join(", ")}`;
  return `File not found: ${requested}.${inside ? " Use ls, glob or repo_map to see which files exist." : ""}`;
}
