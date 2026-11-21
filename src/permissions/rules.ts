import path from "node:path";

/**
 * A permission rule from settings: `tool` or `tool(pattern)`.
 *
 * - `bash(git status)`     exactly that command
 * - `bash(npm run test:*)` that command, alone or followed by arguments
 * - `bash(git * --dry-run)` `*` is a wildcard
 * - `edit(src/**)`         file tools take a glob on the path (relative to the project root)
 * - `write`                every call of the tool; `*` matches every tool
 */
export interface Rule {
  tool: string;
  pattern?: string;
  /** The rule as written, for messages. */
  raw: string;
}

export interface RuleSet {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

export interface ParsedRules {
  allow: Rule[];
  deny: Rule[];
  ask: Rule[];
}

const RULE_RE = /^([A-Za-z0-9_*.-]+)(?:\((.*)\))?$/s;

export function parseRule(raw: string): Rule {
  const m = RULE_RE.exec(raw.trim());
  if (!m) throw new Error(`Invalid permission rule "${raw}": use tool or tool(pattern), e.g. bash(git status:*)`);
  const pattern = m[2]?.trim();
  return { tool: m[1]!.toLowerCase(), ...(pattern && pattern !== "*" && pattern !== "**" ? { pattern } : {}), raw: raw.trim() };
}

export function parseRules(set: RuleSet = {}): ParsedRules {
  return {
    allow: (set.allow ?? []).map(parseRule),
    deny: (set.deny ?? []).map(parseRule),
    ask: (set.ask ?? []).map(parseRule),
  };
}

const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "ls"]);

export interface MatchContext {
  root: string;
  /** One-line summary of the call (used for tools without a better field). */
  summary: string;
}

/** Does the rule cover this call? For bash, `segments` decides compound commands. */
export function ruleMatches(rule: Rule, tool: string, input: unknown, ctx: MatchContext): boolean {
  if (rule.tool !== "*" && rule.tool !== tool.toLowerCase()) return false;
  if (rule.pattern === undefined) return true;
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "bash") return bashMatches(rule.pattern, String(i.command ?? ""));
  if (FILE_TOOLS.has(tool)) {
    const p = typeof i.path === "string" ? i.path : ".";
    return pathMatches(rule.pattern, p, ctx.root);
  }
  return wildcard(rule.pattern).test(ctx.summary);
}

/** Bash pattern against one simple command. */
export function bashMatches(pattern: string, command: string): boolean {
  const cmd = normalizeSpace(command);
  if (pattern.endsWith(":*")) {
    const prefix = normalizeSpace(pattern.slice(0, -2));
    return cmd === prefix || cmd.startsWith(prefix + " ");
  }
  if (pattern.includes("*")) return wildcard(normalizeSpace(pattern)).test(cmd);
  return cmd === normalizeSpace(pattern);
}

function pathMatches(pattern: string, target: string, root: string): boolean {
  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs).split(path.sep).join("/") || ".";
  let pat = pattern.replace(/\\/g, "/");
  if (pat.endsWith("/")) pat += "**";
  const absolute = /^([A-Za-z]:)?\//.test(pat) || pat.startsWith("~");
  if (absolute) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const full = pat.startsWith("~") ? home.replace(/\\/g, "/") + pat.slice(1) : pat;
    return globTest(full, abs.split(path.sep).join("/"));
  }
  // A pattern without a slash matches the file name anywhere (like .gitignore).
  if (!pat.includes("/")) return globTest(pat, path.posix.basename(rel)) || globTest(pat, rel);
  return globTest(pat, rel) || (pat.endsWith("/**") && rel === pat.slice(0, -3));
}

function globTest(pattern: string, target: string): boolean {
  const caseless = process.platform === "win32";
  return path.posix.matchesGlob(caseless ? target.toLowerCase() : target, caseless ? pattern.toLowerCase() : pattern);
}

function wildcard(pattern: string): RegExp {
  const src = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${src}$`, "s");
}

function normalizeSpace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Split a shell command into simple commands on `&&`, `||`, `;`, `|`, `&` and
 * newlines, outside quotes. Good enough to stop `git status && rm -rf x` from
 * riding on an allow rule for `git status`.
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
      // `2>&1` and `&>` are redirections, not separators.
      else if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
        cur += c;
        continue;
      }
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Command substitution or output redirection makes a command unsafe to auto-allow by prefix. */
export function hasShellTricks(command: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`" || (c === "$" && command[i + 1] === "(")) return true;
    if (quote === '"') {
      if (c === '"') quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === ">" && !/^>&\d/.test(command.slice(i)) && !/^>\s*\/dev\/null/.test(command.slice(i))) return true;
    else if (c === "<" && command[i + 1] === "(") return true;
  }
  return false;
}
