/**
 * A mutation the check has written into the worktree but not yet put back.
 * Journalled before the change, cleared after the restore, and restored when
 * the runner starts again, so a crash or a power cut never leaves a broken
 * line in the work: the record reaches the drive before the mutant does, and
 * the original does before the record goes.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { overwriteDurable, writeJsonDurable } from "../atomic-write";

const FILE = "mutation-pending.json";

export async function writePendingMutation(runDir: string, path: string, original: string) {
  await writeJsonDurable(join(runDir, FILE), { path, original });
}

export async function putBackMutation(runDir: string, path: string, original: string) {
  await overwriteDurable(path, original);
  await rm(join(runDir, FILE), { force: true });
}

export async function restorePendingMutation(runDir: string): Promise<boolean> {
  const saved = await readFile(join(runDir, FILE), "utf8").catch(() => undefined);
  if (!saved) return false;
  const { path, original } = JSON.parse(saved) as { path: string; original: string };
  await putBackMutation(runDir, path, original);
  return true;
}
