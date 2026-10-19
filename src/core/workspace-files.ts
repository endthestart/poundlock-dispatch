import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export async function listWorkspaceFiles(
  workspace: string,
): Promise<Array<{ path: string; content: Buffer; executable: boolean }>> {
  const files: Array<{ path: string; content: Buffer; executable: boolean }> = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      files.push({
        path: relative(workspace, full).split(sep).join("/"),
        content: await readFile(full),
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  }

  await walk(workspace);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
