import { execa } from "execa";
import type { Block } from "../providers/types.js";
import { detectShell } from "../tools/shell.js";
import { reminder, type Agent, type AgentEvent } from "./loop.js";

export interface GoalOptions {
  objective: string;
  /** Shell command that exits 0 when the goal is met (e.g. "npm test"). */
  check?: string;
  /** Rounds (prompts to the model) before giving up; default 8. */
  maxRounds?: number;
}

export interface CheckResult {
  ok: boolean;
  code: number;
  output: string;
}

export type CheckRunner = (command: string, root: string, signal: AbortSignal) => Promise<CheckResult>;

const DONE_MARK = "GOAL COMPLETE";
const CHECK_OUTPUT = 4000;

/** Run the check command in the project's shell (up to 10 minutes). */
export const runCheck: CheckRunner = async (command, root, signal) => {
  const shell = detectShell();
  const args = shell.kind === "bash" ? ["-c", command] : ["-NoProfile", "-NonInteractive", "-Command", command];
  const r = await execa(shell.path, args, { cwd: root, all: true, reject: false, timeout: 600_000, cancelSignal: signal, windowsHide: true, stdin: "ignore", env: { FORGE: "1", CI: "1" } });
  const output = String(r.all ?? "");
  return { ok: r.exitCode === 0 && !r.timedOut && !r.isCanceled, code: r.exitCode ?? -1, output: output.length > CHECK_OUTPUT ? `…${output.slice(-CHECK_OUTPUT)}` : output };
};

/**
 * Parse "/goal" arguments: the objective, then optional --check "<cmd>" and
 * --max-rounds N (in any order after the objective).
 */
export function parseGoalArgs(args: string): GoalOptions | undefined {
  let rest = args;
  let check: string | undefined;
  let maxRounds: number | undefined;
  const checkRe = /--check\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/;
  const m = checkRe.exec(rest);
  if (m) {
    check = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\"/g, '"');
    rest = rest.replace(m[0], " ");
  }
  const r = /--max-rounds\s+(\d+)/.exec(rest);
  if (r) {
    maxRounds = Number(r[1]);
    rest = rest.replace(r[0], " ");
  }
  const objective = rest.replace(/\s+/g, " ").trim();
  if (!objective) return undefined;
  return { objective, ...(check ? { check } : {}), ...(maxRounds ? { maxRounds } : {}) };
}

/**
 * Keep the agent working on an objective across turns: after each turn, run
 * the check (or look for the model's GOAL COMPLETE), and send it back with
 * the failure until the goal is met or the rounds run out. Budgets set on the
 * agent still apply to every turn.
 */
export async function* runGoal(agent: Agent, root: string, goal: GoalOptions, signal: AbortSignal, check: CheckRunner = runCheck): AsyncGenerator<AgentEvent> {
  const maxRounds = goal.maxRounds ?? 8;
  yield { type: "goal", phase: "start", text: `Goal: ${goal.objective}${goal.check ? ` · done when \`${goal.check}\` passes` : ""} · up to ${maxRounds} rounds` };
  if (goal.check) {
    const first = await check(goal.check, root, signal);
    if (signal.aborted) return yield { type: "goal", phase: "stopped", text: "Goal interrupted." };
    if (first.ok) return yield { type: "goal", phase: "done", text: `\`${goal.check}\` already passes; nothing to do.` };
  }
  const how = goal.check
    ? `The goal is met when \`${goal.check}\` exits successfully; Forge runs it after each of your turns and shows you the output when it fails.`
    : `When the goal is fully met (verified, not just attempted), end your reply with the line ${DONE_MARK}. Until then, keep working; Forge will send you back to it.`;
  let prompt: string | Block[] = [{ type: "text", text: goal.objective }, reminder(`This is a goal to work on autonomously, across several turns if needed. ${how} Work in small verified steps and keep a task list for multi-step work.`)];
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) yield { type: "goal", phase: "round", text: `Round ${round}/${maxRounds}` };
    let final: Extract<AgentEvent, { type: "done" }> | undefined;
    for await (const ev of agent.send(prompt, signal)) {
      if (ev.type === "done") final = ev;
      yield ev;
    }
    if (signal.aborted || !final || final.stop === "aborted") return yield { type: "goal", phase: "stopped", text: "Goal interrupted." };
    if (final.stop === "budget" || final.stop === "refusal" || final.stop === "blocked") {
      return yield { type: "goal", phase: "stopped", text: `Goal stopped: ${final.detail ?? final.stop}.` };
    }
    if (goal.check) {
      const r = await check(goal.check, root, signal);
      if (signal.aborted) return yield { type: "goal", phase: "stopped", text: "Goal interrupted." };
      if (r.ok) return yield { type: "goal", phase: "done", text: `Goal met: \`${goal.check}\` passes (after ${round} round${round === 1 ? "" : "s"}).` };
      yield { type: "goal", phase: "check", text: `\`${goal.check}\` still fails (exit ${r.code}).` };
      // A visible message, not a hidden reminder: small models act on it more reliably, and the user sees it too.
      prompt = `\`${goal.check}\` still fails (exit code ${r.code}):\n\n\`\`\`\n${r.output.trim() || "(no output)"}\n\`\`\`\n\nFix this and keep working on the goal: ${goal.objective}`;
    } else {
      if (final.text.includes(DONE_MARK)) return yield { type: "goal", phase: "done", text: `Goal met (after ${round} round${round === 1 ? "" : "s"}).` };
      prompt = `Keep working on the goal: ${goal.objective}\nIf it is fully met and verified, say so and end with ${DONE_MARK}.`;
    }
  }
  yield { type: "goal", phase: "stopped", text: `Stopped after ${maxRounds} rounds without meeting the goal.` };
}
