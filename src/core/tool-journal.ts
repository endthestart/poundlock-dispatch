import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "@core/atomic-write";
import { newId, nowIso } from "@core/ids";
import type { FailureClass } from "@shared/types";

type JournalStatus = "pending" | "completed" | "needs_reconciliation";

export interface ToolJournalRecord {
  eventId: string;
  createdAt: string;
  completedAt?: string;
  status: JournalStatus;
  piSessionId?: string;
  piMessageId?: string;
  toolCallId?: string;
  workflowId?: string;
  planRevision?: number;
  taskId?: string;
  attemptId?: string;
  action: {
    tool: string;
    path?: string;
    program?: string;
    arguments?: string[];
    cwd?: string;
    executable?: string;
    executableSource?: string;
    capability?: string;
    networkMode?: string;
    timeoutMs?: number;
  };
  authorization: "allow" | "ask" | "deny" | "sandbox";
  sideEffectScope: string[];
  result?: { error?: string; failureClass?: FailureClass };
}

export class ToolJournal {
  constructor(private readonly directory: string) {}

  async begin(
    record: Omit<ToolJournalRecord, "eventId" | "createdAt" | "status">,
  ): Promise<ToolJournalRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const full: ToolJournalRecord = {
      ...record,
      eventId: newId("act"),
      createdAt: nowIso(),
      status: "pending",
    };
    await writeJsonAtomic(this.path(full.eventId), full);
    return full;
  }

  async complete(eventId: string, result?: ToolJournalRecord["result"]): Promise<void> {
    const current = await this.read(eventId);
    if (!current) return;
    current.status = "completed";
    current.completedAt = nowIso();
    current.result = result;
    await writeJsonAtomic(this.path(eventId), current);
  }

  async recordDenied(
    record: Omit<ToolJournalRecord, "eventId" | "createdAt" | "status" | "completedAt">,
  ): Promise<ToolJournalRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const full: ToolJournalRecord = {
      ...record,
      authorization: "deny",
      eventId: newId("act"),
      createdAt: nowIso(),
      completedAt: nowIso(),
      status: "completed",
      result: record.result ?? { error: "denied" },
    };
    await writeJsonAtomic(this.path(full.eventId), full);
    return full;
  }

  async markNeedsReconciliation(eventId: string): Promise<void> {
    const current = await this.read(eventId);
    if (!current || current.status === "completed") return;
    current.status = "needs_reconciliation";
    await writeJsonAtomic(this.path(eventId), current);
  }

  async unresolved(): Promise<ToolJournalRecord[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const records: ToolJournalRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.read(name.replace(/\.json$/, ""));
      if (record && record.status !== "completed") records.push(record);
    }
    return records;
  }

  async reconcileOnStart(): Promise<ToolJournalRecord[]> {
    const open = await this.unresolved();
    for (const record of open) {
      if (record.status === "pending") await this.markNeedsReconciliation(record.eventId);
    }
    return this.unresolved();
  }

  /**
   * Complete records that a user has already seen in the recovery state. This
   * never asserts that the interrupted action succeeded; it only records that
   * an explicit later resume may proceed without replaying it automatically.
   */
  async acknowledgeReconciliation(eventId: string): Promise<void> {
    const current = await this.read(eventId);
    if (!current || current.status !== "needs_reconciliation") return;
    await this.complete(eventId, {
      error: "Interrupted action acknowledged during an explicit workflow resume; outcome unknown.",
    });
  }

  async read(eventId: string): Promise<ToolJournalRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.path(eventId), "utf8")) as ToolJournalRecord;
    } catch {
      return undefined;
    }
  }

  private path(eventId: string): string {
    return join(this.directory, `${eventId}.json`);
  }
}
