/**
 * UI snapshots as attempt evidence. A test renders a view off-screen into the
 * project's `.dispatch/evidence/` folder; Dispatch keeps the images written
 * during an attempt with that attempt, and the owner sees them on the task
 * without running the app. An empty window, an upside-down grid or a sheet
 * that never closes each shows in one picture.
 */
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** Where a project's tests write snapshots, relative to the project root. */
export const SNAPSHOT_FOLDER = ".dispatch/evidence";
const IMAGE = /\.(png|jpe?g)$/i;
const MAX_SNAPSHOTS = 12;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** A snapshot file name as stored: a plain image name, nothing that walks a path. */
export function isSnapshotName(name: string): boolean {
  return name === basename(name) && !name.startsWith(".") && IMAGE.test(name);
}

/**
 * Copy the snapshots written since `since` (ms) into `<dataDir>/snapshots`,
 * newest first up to a dozen, and return their names.
 */
export async function keepSnapshots(
  projectRoot: string,
  dataDir: string,
  since: number,
): Promise<string[]> {
  const folder = join(projectRoot, SNAPSHOT_FOLDER);
  const names = await readdir(folder).catch(() => [] as string[]);
  const fresh: Array<{ name: string; modified: number }> = [];
  for (const name of names.filter(isSnapshotName)) {
    const info = await stat(join(folder, name)).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs >= since - 1000 && info.size <= MAX_SNAPSHOT_BYTES)
      fresh.push({ name, modified: info.mtimeMs });
  }
  const kept = fresh.sort((a, b) => b.modified - a.modified).slice(0, MAX_SNAPSHOTS);
  if (!kept.length) return [];
  await mkdir(join(dataDir, "snapshots"), { recursive: true, mode: 0o700 });
  for (const { name } of kept) await copyFile(join(folder, name), join(dataDir, "snapshots", name));
  return kept.map(({ name }) => name).sort();
}

/** A kept snapshot as a data URL, for the renderer, which cannot read files itself. */
export async function snapshotDataUrl(attemptDir: string, name: string): Promise<string> {
  if (!isSnapshotName(name)) throw new Error("Not a snapshot name.");
  const bytes = await readFile(join(attemptDir, "snapshots", name));
  const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
  return `data:${type};base64,${bytes.toString("base64")}`;
}
