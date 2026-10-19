import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigLayout, DataLayout } from "./paths.js";

/**
 * Move this machine's Poundlock connection out of a client's data directory
 * and into the config directory every client reads. `from` names the directory
 * to take it out of, which is not always this client's own: the desktop app
 * held the only copy before there was a second client, so a terminal session
 * starting first migrates from there rather than asking for a token that
 * already exists on this machine.
 *
 * Connection files were written before there was a second client, so an
 * existing desktop install holds the only copy of the controller URL, its
 * token, the role map and the model ladder. Without this the first terminal
 * session would demand all of it again. Runs once: it never overwrites a
 * config directory that already has a connection, and it moves rather than
 * copies so there is no second copy to drift.
 */
export function migrateSharedConfig(layout: DataLayout, from = layout.root): boolean {
  if (existsSync(layout.config.connection)) return false;
  const legacy = legacyPaths(from);
  if (!existsSync(legacy.connection)) return false;
  mkdirSync(layout.config.root, { recursive: true, mode: 0o700 });
  for (const key of ["connection", "secret", "integrations", "integrationsSecret"] as const) {
    if (existsSync(legacy[key])) renameSync(legacy[key], layout.config[key]);
  }
  splitPermissions(layout, from);
  return true;
}

/** Where each file lived when one directory held both config and projects. */
function legacyPaths(root: string): Omit<ConfigLayout, "root" | "defaults" | "appearance"> {
  return {
    connection: join(root, "connection.json"),
    secret: join(root, "connection.secret.json"),
    integrations: join(root, "integrations.json"),
    integrationsSecret: join(root, "integrations.secret.json"),
  };
}

/**
 * `permissions.json` mixed the machine's default trust mode with grants keyed
 * by project id. The default follows the connection; the grants stay with the
 * projects they name.
 */
function splitPermissions(layout: DataLayout, from: string): void {
  const source = join(from, "permissions.json");
  if (!existsSync(source) || existsSync(layout.config.defaults)) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const { grants, ...defaults } = parsed;
  writeFileSync(layout.config.defaults, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
  // Grants name projects this client may not have, so they stay where they are.
  if (source !== layout.permissions) return;
  writeFileSync(layout.permissions, `${JSON.stringify(grants ? { grants } : {}, null, 2)}\n`, {
    mode: 0o600,
  });
}
