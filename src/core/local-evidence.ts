import { createHash } from "node:crypto";
import { ListedFileChanged, openListedFile } from "./listed-file";
import { listLiveProjectFiles } from "./snapshot";

export interface LocalEvidence {
  manifest: Array<{
    path: string;
    sha256: string;
    bytes: number;
    executable: boolean;
    patchAvailable: boolean;
  }>;
  files: Array<{ path: string; content: Buffer; executable: boolean }>;
}

/** Local evidence is not constrained by Poundlock's source-upload byte limit.
 * Hash large assets without copying them into the client's review data. */
export async function captureLocalEvidence(
  root: string,
  exclusions: string[],
): Promise<LocalEvidence> {
  const listed = await listLiveProjectFiles(root, exclusions, 10_001);
  if (listed.length > 10_000)
    throw new Error(
      "More than 10,000 source files need change tracking. Narrow the project's exclusions before starting.",
    );
  const evidence: LocalEvidence = { manifest: [], files: [] };
  let copiedBytes = 0;
  for (const file of listed) {
    // Like a link, a file swapped for one after the listing is left out: its
    // target never reaches the review patch or the manager (M8).
    const opened = await openListedFile(root, file.path).catch((error) => {
      if (error instanceof ListedFileChanged || error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!opened) continue;
    const { handle, stat } = opened;
    try {
      const hash = createHash("sha256");
      const executable = Boolean(stat.mode & 0o111);
      const patchAvailable = stat.size <= 1_000_000 && copiedBytes + stat.size <= 16_000_000;
      let content: Buffer | undefined;
      if (patchAvailable) {
        content = await handle.readFile();
        hash.update(content);
      } else {
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      }
      evidence.manifest.push({
        path: file.path,
        sha256: hash.digest("hex"),
        bytes: stat.size,
        executable,
        patchAvailable,
      });
      if (content) {
        copiedBytes += content.length;
        evidence.files.push({ path: file.path, content, executable });
      }
    } finally {
      await handle.close();
    }
  }
  return evidence;
}
