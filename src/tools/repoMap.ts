import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { z } from "zod";
import { displayPath, resolvePath } from "./paths.js";
import { defineTool } from "./types.js";

const run = promisify(execFile);

const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", "out", "target", ".next", ".venv", "venv", "__pycache__", "vendor", "coverage", ".turbo", ".cache"];
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_TOKENS = 2000;

/** Per language: regexes whose first group is a top-level symbol name. */
const PATTERNS: Array<{ ext: RegExp; res: RegExp[] }> = [
  {
    ext: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
    res: [
      /^export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
      /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      /^export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
      /^export\s+const\s+([A-Za-z_$][\w$]*)/gm,
      /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
      /^class\s+([A-Za-z_$][\w$]*)/gm,
    ],
  },
  { ext: /\.py$/, res: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm] },
  { ext: /\.go$/, res: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm] },
  {
    ext: /\.rs$/,
    res: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/gm, /^(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, /^(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm],
  },
  {
    ext: /\.(java|kt|kts|cs|scala|swift)$/,
    res: [/^\s*(?:public\s+|internal\s+|open\s+|abstract\s+|sealed\s+|final\s+|static\s+|data\s+)*(?:class|interface|enum|record|object|struct|protocol)\s+([A-Za-z_]\w*)/gm],
  },
  { ext: /\.(c|h|cc|cpp|hpp|cxx)$/, res: [/^(?:struct|class|enum)\s+([A-Za-z_]\w*)\s*\{/gm, /^[A-Za-z_][\w\s*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/gm] },
  { ext: /\.rb$/, res: [/^\s*(?:class|module)\s+([A-Z]\w*)/gm, /^\s*def\s+(?:self\.)?([a-z_]\w*[?!]?)/gm] },
  { ext: /\.php$/, res: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/gm, /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/gm] },
];

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|scala|swift|c|h|cc|cpp|hpp|cxx|rb|php|vue|svelte)$/;

export interface MapEntry {
  file: string;
  symbols: string[];
}

/** Top-level symbols defined in a source file. */
export function extractSymbols(file: string, text: string): string[] {
  const lang = PATTERNS.find((p) => p.ext.test(file));
  if (!lang) return [];
  const found: Array<{ at: number; name: string }> = [];
  for (const re of lang.res) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (name && !["if", "for", "while", "switch", "return", "main"].includes(name)) found.push({ at: m.index ?? 0, name });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.name))];
}

/** Lay entries out as "path: a, b, c" lines within a character budget. */
export function renderMap(entries: MapEntry[], budgetChars: number): string {
  const lines = (perFile: number) =>
    entries.map((e) => {
      const syms = perFile === Infinity ? e.symbols : e.symbols.slice(0, perFile);
      const more = e.symbols.length > syms.length ? `, +${e.symbols.length - syms.length}` : "";
      return syms.length ? `${e.file}: ${syms.join(", ")}${more}` : e.file;
    });
  for (const perFile of [Infinity, 12, 6, 3, 0]) {
    const text = lines(perFile).join("\n");
    if (text.length <= budgetChars) return text;
  }
  // Still too big: list directories with file counts.
  const dirs = new Map<string, number>();
  for (const e of entries) {
    const d = path.posix.dirname(e.file);
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const dirLines = [...dirs].map(([d, n]) => `${d}/ (${n} files)`);
  const kept: string[] = [];
  let len = 0;
  for (const l of dirLines) {
    if (len + l.length + 1 > budgetChars) break;
    kept.push(l);
    len += l.length + 1;
  }
  const rest = dirLines.length - kept.length;
  return `Too many files to list; directories instead (call repo_map with a path for detail):\n${kept.join("\n")}${rest ? `\n… ${rest} more directories` : ""}`;
}

/** Files in a directory, relative, honouring .gitignore when it is a git repository. */
export async function listProjectFiles(dir: string): Promise<string[]> {
  // git ls-files honours .gitignore; fall back to a glob outside repositories.
  try {
    const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: dir, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const files = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (files.length) return files;
  } catch {
    // not a git repository, or git is missing
  }
  return fg("**/*", { cwd: dir, onlyFiles: true, dot: false, suppressErrors: true, ignore: IGNORED_DIRS.map((d) => `**/${d}/**`) });
}

/** Build the map for a directory: source files and their top-level symbols. */
export async function buildRepoMap(dir: string): Promise<{ entries: MapEntry[]; truncated: boolean }> {
  const all = (await listProjectFiles(dir)).filter((f) => !f.split("/").some((part) => IGNORED_DIRS.includes(part))).sort();
  const code = all.filter((f) => CODE_EXT.test(f));
  const truncated = code.length > MAX_FILES;
  const entries: MapEntry[] = [];
  await Promise.all(
    code.slice(0, MAX_FILES).map(async (file, i) => {
      let symbols: string[] = [];
      try {
        const abs = path.join(dir, file);
        const st = await fs.stat(abs);
        if (st.size <= MAX_FILE_BYTES) symbols = extractSymbols(file, await fs.readFile(abs, "utf8"));
      } catch {
        // unreadable or deleted: list it without symbols
      }
      entries[i] = { file, symbols };
    }),
  );
  return { entries: entries.filter(Boolean), truncated };
}

export const repoMapTool = defineTool({
  name: "repo_map",
  description: `Get an overview of the project: every source file with the functions, classes and types it defines. Use it first in an unfamiliar codebase to find where things live, then read only the files you need.
- Pass path to map one directory in more detail.
- Respects .gitignore; node_modules, build output and similar are skipped.`,
  schema: z.object({
    path: z.string().optional().describe("Directory to map (default: the project root)"),
    max_tokens: z.number().int().min(200).max(20_000).optional().describe(`Size limit for the map (default ${DEFAULT_TOKENS})`),
  }),
  readOnly: true,
  summarize: (i) => i.path ?? ".",
  async run(input, ctx) {
    const dir = resolvePath(ctx, input.path ?? ".", { allowOutside: true });
    const { entries, truncated } = await buildRepoMap(dir);
    if (!entries.length) return { content: "No source files found." };
    const prefix = path.relative(ctx.root, dir) ? `${displayPath(ctx.root, dir)}/` : "";
    const shown = prefix ? entries.map((e) => ({ ...e, file: prefix + e.file })) : entries;
    const map = renderMap(shown, (input.max_tokens ?? DEFAULT_TOKENS) * 4);
    const note = truncated ? `\n[only the first ${MAX_FILES} source files; pass a path to narrow]` : "";
    return { content: `${entries.length} source files\n${map}${note}` };
  },
});
