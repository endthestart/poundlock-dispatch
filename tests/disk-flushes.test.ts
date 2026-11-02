/**
 * On macOS a flush empties the whole drive cache (~20 ms, and many times the
 * file's size in SSD writes), so only what a power cut must not lose is
 * flushed: settings, secrets, permission grants. Project state, the tool
 * journal and folder locks are replaced atomically without one, and a status
 * polled on a timer is rewritten only when it changes.
 */
import { existsSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { AutoLedger } from "@core/auto/ledger";
import { ToolJournal } from "@core/tool-journal";
import { afterEach, expect, it, vi } from "vitest";
import {
  countingManager,
  engineFor,
  planTask,
  recordingWorker,
  settle,
  workflowFixture,
} from "./support/workflow-fixture";

/** Counts every flush any file handle in this process makes from now on. */
async function flushCounter(): Promise<() => number> {
  const probe = await open(process.execPath, "r");
  const handle = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = vi.spyOn(handle, "sync");
  const datasync = vi.spyOn(handle, "datasync");
  return () => sync.mock.calls.length + datasync.mock.calls.length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("works a plan from proposal to accepted without flushing the drive", async () => {
  const f = await workflowFixture();
  const { manager } = countingManager(f.store, { tasks: [planTask("Write")] });
  const engine = engineFor(f, manager, recordingWorker().worker);
  const flushes = await flushCounter();
  await engine.sendMessage(f.project.id, "Plan this work");
  await engine.approveAndStart(f.project.id);
  await settle(engine, f.project.id);
  expect((await f.store.getTasks(f.project.id)).map((task) => task.status)).toEqual(["applied"]);
  expect((await f.store.getMessages(f.project.id)).length).toBeGreaterThan(1);
  expect(flushes()).toBe(0);
});

it("journals a tool call without flushing the drive", async () => {
  const f = await workflowFixture();
  const journal = new ToolJournal(join(f.root, "journal"));
  const flushes = await flushCounter();
  const record = await journal.begin({
    action: { tool: "write", path: join(f.folder, "a.txt") },
    authorization: "allow",
    sideEffectScope: [f.folder],
  });
  await journal.complete(record.eventId);
  expect(await journal.unresolved()).toEqual([]);
  expect(flushes()).toBe(0);
});

it("rewrites an Autopilot run's status only when it changes", async () => {
  const f = await workflowFixture();
  const ledger = new AutoLedger(join(f.root, "run"));
  await ledger.append({ type: "run_resumed" });

  await ledger.writeStatus({ pid: 1, activity: "Checking" });
  expect(existsSync(ledger.statusFile)).toBe(true);
  await rm(ledger.statusFile);
  await ledger.writeStatus({ pid: 1, activity: "Checking" });
  expect(existsSync(ledger.statusFile)).toBe(false);
  await ledger.writeStatus({ pid: 1, activity: "Committing" });
  expect(existsSync(ledger.statusFile)).toBe(true);
  await rm(ledger.statusFile);
  await ledger.append({ type: "stop_requested", mode: "now" });
  await ledger.writeStatus({ pid: 1, activity: "Committing" });
  expect(existsSync(ledger.statusFile)).toBe(true);
});

it("flushes settings, secrets and grants to the drive, each with its folder", async () => {
  const f = await workflowFixture();
  const flushes = await flushCounter();
  await f.store.saveConnection({ ...(await f.store.getConnection()), token: "rotated" });
  expect(flushes()).toBe(4);
  await f.store.savePermissions(await f.store.getPermissions());
  expect(flushes()).toBe(8);
});
