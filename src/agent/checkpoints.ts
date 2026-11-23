import fs from "node:fs/promises";
import path from "node:path";

/** Files bigger than this aren't snapshotted (rewinding leaves them alone). */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** A file as it was before the first change in a checkpoint: its bytes, absent (null), or too big to keep. */
export type Snapshot = { kind: "content"; data: Buffer } | { kind: "absent" } | { kind: "too-big" };

/** The state before one prompt: where the conversation was, and files as they were before Forge changed them. */
export interface Checkpoint {
  /** 1-based, in prompt order. */
  n: number;
  at: number;
  prompt: string;
  /** messages.length before the prompt was added. */
  messageIndex: number;
  files: Map<string, Snapshot>;
}

export interface RestorePlan {
  /** Files to put back, with what to put back. */
  files: Array<{ path: string; snapshot: Snapshot }>;
  /** Files changed on disk since Forge last wrote them (by you, an editor, or a command). */
  changedOutside: string[];
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  skipped: string[];
}

/**
 * Checkpoints for one session: before write/edit change a file, its old
 * contents are kept once per prompt, so /rewind can put the code back as it
 * was before any prompt. Changes made by shell commands aren't tracked.
 */
export class Checkpoints {
  readonly list: Checkpoint[] = [];
  /** mtime of each file right after Forge last wrote it. */
  private readonly written = new Map<string, number>();

  /** Start the checkpoint for a new prompt. */
  begin(prompt: string, messageIndex: number): Checkpoint {
    const cp: Checkpoint = { n: this.list.length + 1, at: Date.now(), prompt, messageIndex, files: new Map() };
    this.list.push(cp);
    return cp;
  }

  get(n: number): Checkpoint | undefined {
    return this.list.find((c) => c.n === n);
  }

  get current(): Checkpoint | undefined {
    return this.list.at(-1);
  }

  /** Call before changing a file: keeps its current state, once per checkpoint. */
  async before(abs: string): Promise<void> {
    const cp = this.current;
    if (!cp || cp.files.has(abs)) return;
    cp.files.set(abs, await snapshot(abs));
  }

  /** Call after Forge wrote a file. */
  after(abs: string, mtime: number): void {
    this.written.set(abs, mtime);
  }

  /** What rewinding the code to before checkpoint n would do. */
  async plan(n: number): Promise<RestorePlan> {
    const earliest = new Map<string, Snapshot>();
    for (const cp of this.list) {
      if (cp.n < n) continue;
      for (const [file, snap] of cp.files) if (!earliest.has(file)) earliest.set(file, snap);
    }
    const files = [...earliest].map(([p, snapshot]) => ({ path: p, snapshot }));
    const changedOutside: string[] = [];
    for (const f of files) {
      const last = this.written.get(f.path);
      if (last === undefined) continue;
      const now = await fs.stat(f.path).then((s) => s.mtimeMs, () => undefined);
      if (now !== last) changedOutside.push(f.path);
    }
    return { files, changedOutside };
  }

  /** Put files back as they were before checkpoint n. */
  async restore(plan: RestorePlan): Promise<RestoreResult> {
    const out: RestoreResult = { restored: [], deleted: [], skipped: [] };
    for (const { path: p, snapshot } of plan.files) {
      if (snapshot.kind === "too-big") {
        out.skipped.push(p);
      } else if (snapshot.kind === "absent") {
        await fs.rm(p, { force: true });
        out.deleted.push(p);
        this.written.delete(p);
      } else {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, snapshot.data);
        out.restored.push(p);
        this.written.set(p, (await fs.stat(p)).mtimeMs);
      }
    }
    return out;
  }

  /** Forget checkpoint n and everything after it (their prompts are gone). */
  truncate(n: number): void {
    const i = this.list.findIndex((c) => c.n >= n);
    if (i !== -1) this.list.length = i;
  }

  clear(): void {
    this.list.length = 0;
  }
}

async function snapshot(abs: string): Promise<Snapshot> {
  try {
    const st = await fs.stat(abs);
    if (st.size > MAX_SNAPSHOT_BYTES) return { kind: "too-big" };
    return { kind: "content", data: await fs.readFile(abs) };
  } catch {
    return { kind: "absent" };
  }
}
