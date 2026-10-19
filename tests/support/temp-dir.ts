import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const created: string[] = [];
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  afterAll(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
}

/**
 * A fresh, uniquely-named directory under the OS temp root, removed once every
 * test in the importing file has run. Every test file that calls this gets its
 * own module instance (and so its own `created` list and single `afterAll`),
 * because Vitest gives each test file an isolated module graph.
 */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  registerCleanup();
  return dir;
}
