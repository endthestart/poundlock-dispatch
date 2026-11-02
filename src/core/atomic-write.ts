import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Replace a file through a temp file and a rename, so a crash or a kill never
 * leaves it half-written. Nothing is flushed, so a power cut can lose the last
 * few seconds of saves: on macOS a flush empties the whole drive cache, which
 * costs ~20 ms and many times the file's size in SSD writes.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await replaceFile(file, data, mode, false);
}

/** `writeFileAtomic`, flushed to the drive with its folder: only for what must survive a power cut. */
export async function writeFileDurable(
  file: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await replaceFile(file, data, mode, true);
}

export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function writeJsonDurable(file: string, value: unknown, mode = 0o600): Promise<void> {
  await writeFileDurable(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Overwrite a file in place, keeping its inode and mode, and flush it to the drive. */
export async function overwriteDurable(file: string, data: string): Promise<void> {
  const handle = await open(file, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function replaceFile(
  file: string,
  data: string | Buffer,
  mode: number,
  durable: boolean,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  if (durable) await syncDirectory(dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
