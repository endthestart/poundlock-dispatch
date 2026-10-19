import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutoEvent,
  type AutoRunState,
  type InboxCommand,
  type InboxEntry,
  type LedgerEntry,
  reduceAutoEvents,
} from "@shared/auto-run";
import { writeJsonAtomic } from "../atomic-write";
import { nowIso } from "../ids";

export interface AutoControl {
  command: "stop" | "stop_now";
  nonce: string;
  at: string;
}

/**
 * One run's folder: an append-only `events.jsonl` (the truth), a derived
 * `status.json` a front end can poll, and `control.json` a front end writes to
 * ask the runner to stop. Appends are fsynced; a torn last line from a crash is
 * ignored on read, so replay never fails on it.
 */
export class AutoLedger {
  readonly eventsFile: string;
  readonly statusFile: string;
  readonly controlFile: string;
  /** Front ends append here; the runner takes each entry once (ADR 016). */
  readonly inboxFile: string;
  private seq = 0;
  /** A crash mid-append left a partial last line: the next append starts a fresh one. */
  private torn = false;

  constructor(
    readonly runDir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.eventsFile = join(runDir, "events.jsonl");
    this.statusFile = join(runDir, "status.json");
    this.controlFile = join(runDir, "control.json");
    this.inboxFile = join(runDir, "inbox.jsonl");
  }

  /** Ask the runner for something. Each line is one small append, so writers never interleave. */
  async postInbox(cmd: InboxCommand, text?: string): Promise<InboxEntry> {
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    const entry: InboxEntry = {
      id: randomUUID(),
      cmd,
      ...(text ? { text } : {}),
      at: nowIso(this.clock),
    };
    const handle = await open(this.inboxFile, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return entry;
  }

  async readInbox(): Promise<InboxEntry[]> {
    const text = await readFile(this.inboxFile, "utf8").catch(() => "");
    const entries: InboxEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as InboxEntry;
        if (entry.id && ["pause", "stop_now", "message"].includes(entry.cmd)) entries.push(entry);
      } catch {
        // A torn last line from a writer that died mid-append.
      }
    }
    return entries;
  }

  private async load(): Promise<{ entries: LedgerEntry[]; torn: boolean }> {
    let text: string;
    try {
      text = await readFile(this.eventsFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], torn: false };
      throw error;
    }
    const entries: LedgerEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        // A torn final line from a crash mid-append. Everything before it stands.
      }
    }
    return { entries, torn: text.length > 0 && !text.endsWith("\n") };
  }

  /** The entries, and where the next append goes. */
  async read(): Promise<LedgerEntry[]> {
    const { entries, torn } = await this.load();
    this.torn = torn;
    this.seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    return entries;
  }

  async append(event: AutoEvent): Promise<LedgerEntry> {
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    if (this.seq === 0) await this.read();
    const entry: LedgerEntry = { seq: ++this.seq, at: nowIso(this.clock), event };
    const handle = await open(this.eventsFile, "a", 0o600);
    try {
      await handle.write(`${this.torn ? "\n" : ""}${JSON.stringify(entry)}\n`);
      await handle.sync();
      this.torn = false;
    } finally {
      await handle.close();
    }
    return entry;
  }

  /** The run's state. A pure read: a heartbeat or a front end never moves the append position. */
  async state(): Promise<AutoRunState> {
    return reduceAutoEvents((await this.load()).entries);
  }

  /** The derived status a front end polls, with the runner's pid and a heartbeat. */
  async writeStatus(extra: { pid: number; activity?: string }): Promise<AutoRunState> {
    const state = await this.state();
    await writeJsonAtomic(this.statusFile, { ...state, ...extra, heartbeatAt: nowIso(this.clock) });
    return state;
  }

  async readControl(): Promise<AutoControl | undefined> {
    try {
      return JSON.parse(await readFile(this.controlFile, "utf8")) as AutoControl;
    } catch {
      return undefined;
    }
  }

  async writeControl(command: AutoControl["command"], nonce: string): Promise<void> {
    await writeJsonAtomic(this.controlFile, {
      command,
      nonce,
      at: nowIso(this.clock),
    } satisfies AutoControl);
  }

  async clearControl(): Promise<void> {
    await rm(this.controlFile, { force: true });
  }
}
