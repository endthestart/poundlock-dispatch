import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Copy before publishing the new data directory; retain legacy paths as backup. */
export function migrateLegacyData(legacy: string, destination: string): boolean {
  if (!existsSync(legacy)) return false;
  if (existsSync(destination) && readdirSync(destination).length) return false;
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), ".dispatch-migration-"));
  try {
    cpSync(legacy, staging, { recursive: true, verbatimSymlinks: true });
    if (existsSync(destination)) rmdirSync(destination);
    renameSync(staging, destination);
    return true;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
