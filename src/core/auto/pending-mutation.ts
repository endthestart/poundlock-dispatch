/**
 * A mutation the check has written into the worktree but not yet put back.
 * Journalled before the change, cleared after the restore, and restored when
 * the runner starts again, so a crash never leaves a broken line in the work.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE = "mutation-pending.json";

export async function writePendingMutation(runDir: string, path: string, original: string) {
  await writeFile(join(runDir, FILE), JSON.stringify({ path, original }), { mode: 0o600 });
}

export async function clearPendingMutation(runDir: string): Promise<void> {
  await rm(join(runDir, FILE), { force: true });
}

export async function restorePendingMutation(runDir: string): Promise<boolean> {
  const saved = await readFile(join(runDir, FILE), "utf8").catch(() => undefined);
  if (!saved) return false;
  const { path, original } = JSON.parse(saved) as { path: string; original: string };
  await writeFile(path, original);
  await clearPendingMutation(runDir);
  return true;
}
