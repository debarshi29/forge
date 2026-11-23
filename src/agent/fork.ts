import path from "node:path";
import { execa } from "execa";
import type { Message } from "../providers/types.js";
import { listSessions, Session, type SessionInfo } from "./session.js";

/** Copy a conversation into a new session (in this project, or another root such as a worktree). */
export function forkSession(messages: Message[], opts: { root: string; model: string; parent?: string; env?: NodeJS.ProcessEnv }): Session {
  const s = new Session(opts.root, opts.model, { ...(opts.env ? { env: opts.env } : {}), ...(opts.parent ? { parent: opts.parent } : {}) });
  s.history(messages, "fork");
  return s;
}

/**
 * Create a git worktree next to the repository, on a new branch, for
 * working on a fork in isolation: ../<repo>-<name> on forge/<name>.
 */
export async function createWorktree(root: string, name: string): Promise<{ path: string; branch: string }> {
  const top = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: root, reject: false });
  if (top.exitCode !== 0) throw new Error("This project isn't a git repository, so it can't have a worktree.");
  const repo = path.resolve(top.stdout.trim());
  const dir = path.join(path.dirname(repo), `${path.basename(repo)}-${name}`);
  const branch = `forge/${name}`;
  const r = await execa("git", ["worktree", "add", "-b", branch, dir], { cwd: repo, reject: false });
  if (r.exitCode !== 0) throw new Error(`git worktree add failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`);
  // Keep the same position inside the repository (e.g. a subfolder project).
  const rel = path.relative(repo, root);
  return { path: rel ? path.join(dir, rel) : dir, branch };
}

/** Sessions related to `id` by forking, as an indented tree. */
export function branchTree(root: string, currentId: string | undefined, env?: NodeJS.ProcessEnv): string {
  const all = listSessions(root, env, 500);
  const byId = new Map(all.map((s) => [s.id, s]));
  // Walk up to the root of the current session's family.
  let top = currentId ? byId.get(currentId) : undefined;
  while (top?.parent && byId.has(top.parent)) top = byId.get(top.parent);
  const family = top ? [top] : [];
  const children = (id: string) => all.filter((s) => s.parent === id).sort((a, b) => a.created.getTime() - b.created.getTime());
  const lines: string[] = [];
  const walk = (s: SessionInfo, depth: number) => {
    const mark = s.id === currentId ? "● " : "  ";
    lines.push(`${"  ".repeat(depth)}${mark}${s.id}  ${s.title.slice(0, 60)}  (${s.messages} msgs)`);
    for (const c of children(s.id)) walk(c, depth + 1);
  };
  for (const f of family) walk(f, 0);
  return lines.length ? lines.join("\n") : "";
}
