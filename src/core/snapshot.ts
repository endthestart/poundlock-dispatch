import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DEFAULT_EXCLUSIONS, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_FILES } from "@shared/types";
import ignore from "ignore";
import { excludedPath } from "./file-access";
import { openListedFile } from "./listed-file";

const LIVE_LIST_CAP = 4_000;

export async function listLiveProjectFiles(
  root: string,
  extraExclusions: string[] = [],
  limit = LIVE_LIST_CAP,
): Promise<Array<{ path: string; bytes: number }>> {
  const canonicalRoot = await realpath(root);
  const ig = ignore().add(DEFAULT_EXCLUSIONS).add(extraExclusions);
  try {
    ig.add(await readFile(join(canonicalRoot, ".gitignore"), "utf8"));
  } catch {
    /* no gitignore */
  }
  const files: Array<{ path: string; bytes: number }> = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const full = join(dir, entry.name);
      const relPath = rel(canonicalRoot, full);
      if (!relPath || relPath === ".") continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ig.ignores(`${relPath}/`)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (ig.ignores(relPath) || (await excludedPath(full, extraExclusions, canonicalRoot)))
        continue;
      try {
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) continue;
        files.push({ path: relPath, bytes: stat.size });
      } catch {
        continue;
      }
    }
  }

  await walk(canonicalRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function collectLiveSnapshot(
  root: string,
  extraExclusions: string[] = [],
): Promise<Array<{ path: string; content: Buffer; executable: boolean }>> {
  const listed = await listLiveProjectFiles(root, extraExclusions, MAX_SNAPSHOT_FILES + 1);
  const canonicalRoot = await realpath(root);
  const out: Array<{ path: string; content: Buffer; executable: boolean }> = [];
  let bytes = 0;
  for (const file of listed) {
    if (out.length >= MAX_SNAPSHOT_FILES) {
      throw new Error(`A durable job can include at most ${MAX_SNAPSHOT_FILES} files.`);
    }
    // Opened without following links and checked against the listing: a
    // swapped-in link to a secret must never reach an upload (M8).
    const { handle, stat } = await openListedFile(canonicalRoot, file.path);
    try {
      if (bytes + stat.size > MAX_SNAPSHOT_BYTES) {
        throw new Error(
          "This durable job would exceed Poundlock's 50 MiB snapshot limit. Narrow the files in the task.",
        );
      }
      const content = await handle.readFile();
      bytes += content.length;
      out.push({
        path: file.path,
        content,
        executable: (stat.mode & 0o111) !== 0,
      });
    } finally {
      await handle.close();
    }
  }
  return out;
}

function rel(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}
