import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isWithin } from "./file-access";

/** A listed file that is no longer the plain file inside the root that the listing found. */
export class ListedFileChanged extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while it was being read.`);
    this.name = "ListedFileChanged";
  }
}

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/**
 * Open a file that a listing of `root` found, and prove it is still that file
 * before anything is read (M8). A process left running in the project can swap
 * a file, or a folder above it, for a link to a secret after the listing:
 * - O_NOFOLLOW refuses a link at the file itself;
 * - the opened file must have the device and inode a fresh lstat reports;
 * - its real path must be inside the root and still be the opened file, which
 *   catches a folder above it swapped for a link, whichever way it is swapped.
 * O_NONBLOCK keeps a FIFO swapped in from hanging the open. The caller closes
 * the handle.
 */
export async function openListedFile(
  root: string,
  relPath: string,
): Promise<{ handle: FileHandle; stat: Stats }> {
  const canonicalRoot = await realpath(root);
  const path = join(canonicalRoot, relPath);
  const listed = await lstat(path);
  if (!listed.isFile()) throw new ListedFileChanged(relPath);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new ListedFileChanged(relPath);
  });
  try {
    const opened = await handle.stat();
    const real = await realpath(path);
    const current = await lstat(real);
    if (
      !opened.isFile() ||
      !sameFile(opened, listed) ||
      !isWithin(canonicalRoot, real) ||
      !sameFile(opened, current)
    )
      throw new ListedFileChanged(relPath);
    return { handle, stat: opened };
  } catch (error) {
    await handle.close();
    throw error instanceof ListedFileChanged ? error : new ListedFileChanged(relPath);
  }
}
