/**
 * One data root for every Dispatch client (ADR 016). The terminal kept its
 * projects in `~/.poundlock-dispatch`, apart from the desktop app's, so a
 * project started in one was invisible in the other and an Autopilot run had
 * two stores to report to. The terminal now uses the app's root; this copies
 * its projects across once. It never moves or deletes the originals.
 */
import { cp, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePermissions } from "@shared/permissions";
import type { ProjectRecord } from "@shared/types";
import { type FileStore, readJsonIfExists } from "./store.js";

/** Where the terminal kept its projects before 0.3.0, and still keeps auto-mode runs. */
export function terminalLegacyRoot(): string {
  return join(homedir(), ".poundlock-dispatch");
}

/**
 * Where Autopilot's runs live, for every front end and the runner: the
 * terminal's old root, which is all the confined VM mounts (its `auto` folder).
 */
export function autoBaseRoot(): string {
  return process.env.POUNDLOCK_DISPATCH_DATA_DIR || terminalLegacyRoot();
}

interface ImportRecord {
  to: string;
  at: string;
  imported: string[];
  archived: string[];
}

const MARKER = "imported-to-app.json";

/**
 * Copy the terminal's projects into `store`'s root, once per target root. A
 * project whose folder the app already has comes across archived, so the
 * folder keeps one live project and the terminal's history stays readable.
 */
export async function importTerminalProjects(
  store: FileStore,
  legacyRoot = terminalLegacyRoot(),
  now = () => new Date(),
): Promise<ImportRecord | undefined> {
  const marker = join(legacyRoot, MARKER);
  const done = await readJsonIfExists<ImportRecord>(marker);
  if (done?.to === store.layout.root) return undefined;
  const legacyProjects = join(legacyRoot, "projects");
  const entries = await readdir(legacyProjects, { withFileTypes: true }).catch(() => []);
  if (!entries.length) return undefined;
  const existing = await store.listProjects();
  const livePaths = new Set(
    existing
      .filter((project) => project.source.kind === "local_folder" && !project.archived)
      .map((project) =>
        project.source.kind === "local_folder" ? project.source.originalPath : "",
      ),
  );
  const record: ImportRecord = {
    to: store.layout.root,
    at: now().toISOString(),
    imported: [],
    archived: [],
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = await readJsonIfExists<ProjectRecord>(
      join(legacyProjects, entry.name, "project.json"),
    );
    if (!project || project.id !== entry.name || (await store.getProject(project.id))) continue;
    await cp(join(legacyProjects, entry.name), join(store.layout.projectsDir, entry.name), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const path = project.source.kind === "local_folder" ? project.source.originalPath : undefined;
    const archive = Boolean(path && livePaths.has(path));
    await store.saveProject({ ...project, archived: project.archived || archive });
    if (path && !archive) livePaths.add(path);
    record.imported.push(project.id);
    if (archive) record.archived.push(project.id);
  }
  // Grants follow their projects; the app's own grants win on a clash.
  const legacyGrants =
    normalizePermissions(await readJsonIfExists(join(legacyRoot, "permissions.json"))).grants ?? {};
  const moved = Object.fromEntries(
    Object.entries(legacyGrants).filter(([id]) => record.imported.includes(id)),
  );
  if (Object.keys(moved).length) {
    const permissions = await store.getPermissions();
    await store.savePermissions({
      ...permissions,
      grants: { ...moved, ...(permissions.grants ?? {}) },
    });
  }
  await writeFile(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}
