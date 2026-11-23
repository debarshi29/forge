import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { ciGoal, commitPrompt, diffBudget, GitError, prPrompt, reviewPrompt } from "../src/commands/git.js";
import type { Block } from "../src/providers/types.js";
import { tempDir } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execa("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd });
const text = (blocks: Block[]) => blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");

async function repo(): Promise<string> {
  const dir = await tempDir();
  await git(dir, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(dir, "app.js"), "export const x = 1;\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "Add app");
  return dir;
}

describe("git commands", () => {
  it("/commit: status, diffs and the log style, behind a short visible prompt", async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, "app.js"), "export const x = 2;\n");
    await fs.writeFile(path.join(dir, "new.js"), "export const y = 1;\n");
    const p = await commitPrompt(dir, "bump x", 32_000);
    expect(p[0]).toEqual({ type: "text", text: "/commit bump x" });
    const all = text(p);
    expect(all).toContain("<system-reminder>");
    expect(all).toContain("?? new.js");
    expect(all).toContain("-export const x = 1;");
    expect(all).toContain("Add app");
    expect(all).toMatch(/never stage secrets/);
  });

  it("/commit refuses a clean tree, and everything refuses a non-repo", async () => {
    const dir = await repo();
    await expect(commitPrompt(dir, "", 32_000)).rejects.toThrow(/Nothing to commit/);
    await expect(commitPrompt(await tempDir(), "", 32_000)).rejects.toBeInstanceOf(GitError);
  });

  it("/pr needs a branch with commits", async () => {
    const dir = await repo();
    await expect(prPrompt(dir, undefined, 32_000)).rejects.toThrow(/You're on main itself/);
    await git(dir, "switch", "-qc", "feature");
    await expect(prPrompt(dir, "main", 32_000)).rejects.toThrow(/no commits that aren't on main/);
    await fs.writeFile(path.join(dir, "feature.js"), "export const f = true;\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "Add the feature flag");
    const p = text(await prPrompt(dir, "main", 32_000));
    expect(p).toContain("branch feature into main");
    expect(p).toContain("- Add the feature flag");
    expect(p).toContain("+export const f = true;");
    expect(p).toContain("never force-push");
  });

  it("/review and /security-review: the branch and working-tree diff, read-only", async () => {
    const dir = await repo();
    await expect(reviewPrompt(dir, undefined, 32_000, "general")).rejects.toThrow(/No changes to review/);
    await git(dir, "switch", "-qc", "work");
    await fs.writeFile(path.join(dir, "q.js"), "db.query('SELECT * FROM t WHERE id = ' + id);\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "Query");
    await fs.writeFile(path.join(dir, "app.js"), "export const x = 3;\n");
    const general = text(await reviewPrompt(dir, undefined, 32_000, "general"));
    expect(general).toContain("Review the changes on work (against main) and uncommitted changes for bugs");
    expect(general).toContain("SELECT * FROM t");
    expect(general).toContain("+export const x = 3;");
    expect(general).toContain("Don't change any files");
    const security = await reviewPrompt(dir, undefined, 32_000, "security");
    expect(security[0]).toEqual({ type: "text", text: "/security-review" });
    expect(text(security)).toMatch(/injection \(SQL, shell/);
  });

  it("/ci needs a pull request", async () => {
    const dir = await repo();
    await expect(ciGoal(dir)).rejects.toThrow(/no pull request/);
  });

  it("sizes diffs to the context window", () => {
    expect(diffBudget(4096)).toBe(6000);
    expect(diffBudget(32_768)).toBe(45_875);
    expect(diffBudget(1_000_000)).toBe(120_000);
  });
});
