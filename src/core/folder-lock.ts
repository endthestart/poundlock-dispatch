/**
 * One writer per folder, across processes.
 *
 * ADR 001 asks Dispatch to "fence concurrent manager-turn owners", and until
 * now nothing did: `ProjectOrchestrator.folderRuns` is a `Set` inside one
 * process, so a terminal session and the desktop app could both attach the
 * same folder and dispatch workers into it at the same time. Separate data
 * directories do not help — the contended resource is the folder.
 *
 * Reading is never fenced. A front end without the lock still shows the
 * transcript, the plan and the task board; it just cannot drive the run. That
 * makes watching a terminal session from the desktop app a feature rather than
 * a collision.
 *
 * The lock is advisory and deliberately small: a file created with `wx`, a
 * heartbeat written by the caller's existing poll, and a holder that is only
 * displaced when it is both silent *and* gone.
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { sha256Text } from "./ids.js";

/** Silent for this long *and* no such process before a lock can be taken over. */
export const STALE_AFTER_MS = 30_000;

export interface FolderLockHolder {
  pid: number;
  /** Which front end holds it, so the other can name it: "gui", "tui". */
  hostApp: string;
  startedAt: string;
  heartbeatAt: string;
  dataRoot: string;
  projectId?: string;
  workflowId?: string;
}

export interface FolderLockPort {
  /** True when this process may drive work in `folder`. */
  holds(folder: string): boolean;
  /** Who holds `folder`, when it is not this process. */
  heldBy(folder: string): Promise<FolderLockHolder | undefined>;
}

/**
 * The folder itself, not the name it was reached by: on macOS `/tmp/x` and
 * `/private/tmp/x` are one folder and must be one lock.
 *
 * Synchronous, because `holds` is consulted from a poll and answering "no" to a
 * folder this process really holds stops all work. A root that does not exist
 * yet (a review workspace before its first patch) resolves through its nearest
 * existing ancestor, so claiming it early and asking about it later agree.
 */
function canonicalPath(folder: string): string {
  const tail: string[] = [];
  let head = folder;
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return folder;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

function keyFor(folder: string): string {
  return `${sha256Text(folder)}.json`;
}

function alive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, so it is still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Locks live beside the shared config rather than in a client's data
 * directory, because two clients with different data directories still
 * contend for the same folder.
 */
export class FolderLock implements FolderLockPort {
  private readonly held = new Map<string, FolderLockHolder>();

  constructor(
    private readonly directory: string,
    private readonly identity: { hostApp: string; dataRoot: string },
    private readonly now: () => Date = () => new Date(),
  ) {}

  private path(folder: string): string {
    return join(this.directory, keyFor(folder));
  }

  private async read(folder: string): Promise<FolderLockHolder | undefined> {
    try {
      return JSON.parse(await readFile(this.path(folder), "utf8")) as FolderLockHolder;
    } catch {
      return undefined;
    }
  }

  /** A holder that stopped heartbeating *and* no longer exists. Both, so a paused debugger keeps its lock. */
  private expired(holder: FolderLockHolder): boolean {
    const silent =
      this.now().getTime() - new Date(holder.heartbeatAt).getTime() > STALE_AFTER_MS ||
      Number.isNaN(new Date(holder.heartbeatAt).getTime());
    return silent && !alive(holder.pid);
  }

  /**
   * Take the lock for `folder`, or report who has it. Acquiring the same
   * folder twice in one process succeeds and does not stack — a client may
   * open a folder it already drives.
   */
  async acquire(
    folder: string,
    binding?: { projectId?: string; workflowId?: string },
  ): Promise<{ ok: true } | { ok: false; holder: FolderLockHolder | undefined }> {
    const canonical = canonicalPath(folder);
    if (this.held.has(canonical)) {
      const mine = { ...this.held.get(canonical)!, ...binding };
      this.held.set(canonical, mine);
      await writeJsonAtomic(this.path(canonical), mine, 0o600);
      return { ok: true };
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const holder: FolderLockHolder = {
      pid: process.pid,
      hostApp: this.identity.hostApp,
      dataRoot: this.identity.dataRoot,
      startedAt: this.now().toISOString(),
      heartbeatAt: this.now().toISOString(),
      ...binding,
    };
    const body = `${JSON.stringify(holder, null, 2)}\n`;
    try {
      await writeFile(this.path(canonical), body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.read(canonical);
      if (existing && !this.expired(existing)) return { ok: false, holder: existing };
      // The previous holder is gone: replace the file rather than deleting
      // and recreating it, so a third process cannot slip into the gap.
      await writeJsonAtomic(this.path(canonical), holder, 0o600);
      const confirmed = await this.read(canonical);
      if (confirmed?.pid !== process.pid) return { ok: false, holder: confirmed };
    }
    this.held.set(canonical, holder);
    return { ok: true };
  }

  /**
   * Acquire several folders as one unit, in a fixed order so two processes
   * asking for the same pair cannot deadlock. Releases everything on the first
   * refusal, so a partial hold is never left behind.
   */
  async acquireAll(
    folders: string[],
    binding?: { projectId?: string; workflowId?: string },
  ): Promise<{ ok: true } | { ok: false; folder: string; holder: FolderLockHolder | undefined }> {
    const taken: string[] = [];
    for (const folder of [...new Set(folders)].sort()) {
      const result = await this.acquire(folder, binding);
      if (!result.ok) {
        for (const done of taken) await this.release(done);
        return { ok: false, folder, holder: result.holder };
      }
      taken.push(folder);
    }
    return { ok: true };
  }

  /**
   * Keys are canonical, so the answer has to be about the folder rather than
   * the string. Getting this wrong is the dangerous direction: a claim this
   * process really holds, reported as not held, stops every dispatch silently.
   */
  holds(folder: string): boolean {
    return this.held.has(folder) || this.held.has(canonicalPath(folder));
  }

  async heldBy(folder: string): Promise<FolderLockHolder | undefined> {
    const canonical = canonicalPath(folder);
    if (this.held.has(canonical)) return undefined;
    const holder = await this.read(canonical);
    return holder && !this.expired(holder) ? holder : undefined;
  }

  /** Renew this process's claim. Called from the caller's existing poll, not a timer of its own. */
  async heartbeat(): Promise<void> {
    for (const [folder, holder] of this.held) {
      const next = { ...holder, heartbeatAt: this.now().toISOString() };
      this.held.set(folder, next);
      await writeJsonAtomic(this.path(folder), next, 0o600).catch(() => undefined);
    }
  }

  async release(folder: string): Promise<void> {
    const canonical = canonicalPath(folder);
    if (!this.held.delete(canonical)) return;
    await rm(this.path(canonical), { force: true }).catch(() => undefined);
  }

  async releaseAll(): Promise<void> {
    for (const folder of [...this.held.keys()]) await this.release(folder);
  }
}

/**
 * Why a front end is read-only right now, in words it can show the user.
 *
 * Phrased as a mode rather than a fault. Watching is a supported way to use a
 * second client — the transcript, plan and board are all live — so leading
 * with "close it" named the least likely thing the user wanted to do, and read
 * as a failure when nothing had failed.
 */
export function lockBlockedMessage(holder: FolderLockHolder | undefined): string {
  const where = holder?.hostApp === "gui" ? "the desktop app" : holder && `the ${holder.hostApp}`;
  const who = where ? `in ${where}` : "in another Poundlock Dispatch client";
  const pid = holder ? ` (process ${holder.pid})` : "";
  return `Watching this project. It is open ${who}${pid}, which is driving the work.`;
}
