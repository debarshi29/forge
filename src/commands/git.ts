import { execa } from "execa";
import type { GoalOptions } from "../agent/goal.js";
import { reminder } from "../agent/loop.js";
import type { Block } from "../providers/types.js";
import { detectShell } from "../tools/shell.js";

/** Run a read-only git/gh command; stdout, or "" if it fails. */
async function out(cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await execa(cmd, args, { cwd, reject: false, timeout: 30_000, windowsHide: true, env: { GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" } });
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

function clip(s: string, max: number, what: string): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[… ${what} cut: ${s.length - max} more characters; read files or run git diff for the rest …]`;
}

/** The visible part ("/commit …") plus the hidden instructions and context. */
function prompt(visible: string, body: string): Block[] {
  return [{ type: "text", text: visible }, reminder(body)];
}

export class GitError extends Error {}

async function requireRepo(root: string): Promise<void> {
  if ((await out("git", ["rev-parse", "--is-inside-work-tree"], root)) !== "true") throw new GitError("This project isn't a git repository.");
}

/** Characters of diff to include, scaled to the model's context window. */
export function diffBudget(contextWindow: number): number {
  return Math.max(6000, Math.min(120_000, Math.floor(contextWindow * 4 * 0.35)));
}

export async function commitPrompt(root: string, hint: string, contextWindow: number): Promise<Block[]> {
  await requireRepo(root);
  const [status, staged, unstaged, log, branch] = await Promise.all([
    out("git", ["status", "--short"], root),
    out("git", ["diff", "--staged"], root),
    out("git", ["diff"], root),
    out("git", ["log", "-n", "8", "--format=%s"], root),
    out("git", ["branch", "--show-current"], root),
  ]);
  if (!status) throw new GitError("Nothing to commit: the working tree is clean.");
  const budget = diffBudget(contextWindow);
  return prompt(
    `/commit${hint ? ` ${hint}` : ""}`,
    `Create a git commit for the current changes${hint ? ` (the user says: ${hint})` : ""}.

1. Decide what belongs in the commit. If changes are already staged, commit exactly those. Otherwise stage the files that belong to this change with git add (by name; never stage secrets such as .env files or credentials, and leave unrelated changes out and mention them).
2. Write the message in the style of the recent commits below: a short imperative subject line (under 72 characters), then a blank line and a body explaining what changed and why, when that isn't obvious.
3. Commit with git commit -m (use a heredoc or several -m flags for the body). Don't push, amend or change git config, and never skip hooks. If a hook fails, fix the problem and make a new commit.
4. Reply with the commit's subject and hash.

Branch: ${branch || "(detached)"}
git status --short:
${status}

Recent commit subjects:
${log || "(no commits yet)"}

Staged diff:
${clip(staged || "(nothing staged)", Math.floor(budget / 2), "staged diff")}

Unstaged diff:
${clip(unstaged || "(none)", Math.floor(budget / 2), "unstaged diff")}`,
  );
}

/** The branch a PR would merge into: the remote's default, else main. */
async function defaultBase(root: string): Promise<string> {
  const head = await out("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
  return head ? head.replace(/^origin\//, "") : "main";
}

export async function prPrompt(root: string, base: string | undefined, contextWindow: number): Promise<Block[]> {
  await requireRepo(root);
  const target = base || (await defaultBase(root));
  const branch = await out("git", ["branch", "--show-current"], root);
  if (!branch) throw new GitError("You're not on a branch (detached HEAD).");
  if (branch === target) throw new GitError(`You're on ${target} itself; create a branch for the change first (git switch -c <name>).`);
  const [log, stat, diff, status, existing] = await Promise.all([
    out("git", ["log", "--format=- %s%n%b", `${target}..HEAD`], root),
    out("git", ["diff", "--stat", `${target}...HEAD`], root),
    out("git", ["diff", `${target}...HEAD`], root),
    out("git", ["status", "--short"], root),
    out("gh", ["pr", "view", "--json", "url", "-q", ".url"], root),
  ]);
  if (existing) throw new GitError(`This branch already has a pull request: ${existing}`);
  if (!log) throw new GitError(`${branch} has no commits that aren't on ${target} yet. /commit first.`);
  return prompt(
    `/pr${base ? ` ${base}` : ""}`,
    `Open a GitHub pull request for branch ${branch} into ${target}.

1. ${status ? "There are uncommitted changes (below). Ask the user whether they belong in the PR before doing anything with them; don't commit them on your own." : "The working tree is clean."}
2. Push the branch: git push -u origin ${branch} (never force-push).
3. Create the PR with gh pr create --base ${target} --head ${branch} --title "<title>" --body-file - (pass the body on stdin with a heredoc). The title is a short summary of the whole change; the body has a "## Summary" with bullet points of what changed and why, and a "## Testing" section saying how it was verified (only what actually happened).
4. Reply with the PR's URL.

Commits on this branch:
${clip(log, 8000, "commit list")}

Changed files:
${stat}

Diff against ${target}:
${clip(diff, diffBudget(contextWindow), "diff")}${status ? `\n\nUncommitted changes:\n${status}` : ""}`,
  );
}

async function diffFor(root: string, pr: string | undefined): Promise<{ label: string; diff: string; base: string }> {
  if (pr) {
    const diff = await out("gh", ["pr", "diff", pr], root);
    if (!diff) throw new GitError(`Couldn't get the diff for PR ${pr} (is gh signed in, and does the PR exist?).`);
    const title = await out("gh", ["pr", "view", pr, "--json", "title,body", "-q", '.title + "\\n\\n" + .body'], root);
    return { label: `pull request ${pr}${title ? `: ${title}` : ""}`, diff, base: "" };
  }
  const base = await defaultBase(root);
  const branch = await out("git", ["branch", "--show-current"], root);
  const committed = branch && branch !== base ? await out("git", ["diff", `${base}...HEAD`], root) : "";
  const working = await out("git", ["diff", "HEAD"], root);
  const diff = [committed, working].filter(Boolean).join("\n");
  if (!diff) throw new GitError(`No changes to review: ${branch && branch !== base ? `${branch} matches ${base} and ` : ""}the working tree is clean.`);
  return { label: branch && branch !== base ? `the changes on ${branch} (against ${base}) and uncommitted changes` : "the uncommitted changes", diff, base };
}

export async function reviewPrompt(root: string, pr: string | undefined, contextWindow: number, focus: "general" | "security"): Promise<Block[]> {
  await requireRepo(root);
  const d = await diffFor(root, pr);
  const instructions =
    focus === "security"
      ? `Do a security review of ${d.label}. Look for vulnerabilities the change introduces: injection (SQL, shell, path traversal, template), missing authentication or authorization checks, secrets in code or logs, unsafe deserialization, SSRF, XSS, weak crypto or randomness, and unsafe handling of user-controlled input. Read the surrounding code to confirm each finding is real and reachable; ignore style issues and theoretical problems with no realistic attack.`
      : `Review ${d.label} for bugs. Look for logic errors, unhandled cases and inputs, broken error handling, race conditions, resource leaks, API misuse, and missing or wrong tests. Read the surrounding code before reporting something, and skip pure style nits.`;
  return prompt(
    focus === "security" ? `/security-review${pr ? ` ${pr}` : ""}` : `/review${pr ? ` ${pr}` : ""}`,
    `${instructions}

Don't change any files: this is a read-only review (use read, grep, glob and repo_map to check context).

Report findings ordered by severity. For each: a one-line summary, the location as path:line, why it is a problem (a concrete failing input or scenario), and a suggested fix. If you find nothing significant, say so plainly instead of inventing issues.

Diff:
${clip(d.diff, diffBudget(contextWindow), "diff")}`,
  );
}

/**
 * /ci as a goal: done when the PR's checks pass. The check prints the failing
 * job logs when they don't, so the model sees what broke.
 */
export async function ciGoal(root: string): Promise<GoalOptions> {
  await requireRepo(root);
  const url = await out("gh", ["pr", "view", "--json", "url", "-q", ".url"], root);
  if (!url) throw new GitError("This branch has no pull request on GitHub, so there's no CI to watch. /pr opens one.");
  const branch = await out("git", ["branch", "--show-current"], root);
  const watch = "gh pr checks --watch --fail-fast --interval 20";
  // With bash, a failure also prints the failing job's log; PowerShell gets the check list only.
  const check =
    detectShell().kind === "bash"
      ? `${watch} || { id=$(gh run list --branch "${branch}" --limit 1 --json databaseId -q '.[0].databaseId'); [ -n "$id" ] && gh run view "$id" --log-failed | tail -n 150; exit 1; }`
      : watch;
  return {
    objective: `Make CI pass for ${url}. When the check fails you'll see the failing job's log: find the cause, fix it, verify locally if you can, then commit and push (never force-push) so CI runs again.`,
    check,
    maxRounds: 5,
  };
}
