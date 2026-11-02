import { chmod, stat } from "node:fs/promises";
import { writeJsonDurable } from "./atomic-write.js";
import { type FileStore, readJsonIfExists } from "./store.js";

type SavedBinding = Record<string, unknown>;

/**
 * Before v0.1.3 a saved role binding kept its approved route as
 * `routingRevision`; since then it is `lastApprovedRoutingRevision`, and both
 * were written with one value. The saved role map and the escalation ladder are
 * rewritten without the old field once, when Dispatch starts, so nothing reads
 * it: a binding with only the old field gets its value as
 * `lastApprovedRoutingRevision`, and every other field is kept. The file is
 * replaced atomically with its own mode. Escalation profiles are part of the
 * escalation policy key, so an escalation granted before the rewrite is asked
 * for again.
 */
export async function retireLegacyRoutingRevision(store: FileStore): Promise<void> {
  const file = store.layout.config.connection;
  const saved = await readJsonIfExists<{
    roles?: Record<string, SavedBinding | undefined>;
    escalation?: { profiles?: SavedBinding[] };
  }>(file);
  if (!saved) return;
  let changed = false;
  const rewrite = (binding: SavedBinding | undefined): SavedBinding | undefined => {
    if (!binding || !("routingRevision" in binding)) return binding;
    changed = true;
    const { routingRevision, ...rest } = binding;
    const approved = rest.lastApprovedRoutingRevision ?? routingRevision;
    return approved === undefined ? rest : { ...rest, lastApprovedRoutingRevision: approved };
  };
  const roles =
    saved.roles &&
    Object.fromEntries(Object.entries(saved.roles).map(([role, item]) => [role, rewrite(item)]));
  const profiles = saved.escalation?.profiles?.map(rewrite);
  if (!changed) return;
  const mode = (await stat(file)).mode & 0o777;
  await writeJsonDurable(
    file,
    {
      ...saved,
      ...(roles ? { roles } : {}),
      ...(profiles ? { escalation: { ...saved.escalation, profiles } } : {}),
    },
    mode,
  );
  // The new file's mode went through the umask.
  await chmod(file, mode);
}
