/**
 * `/project-model`: Project settings → Models in the app. The Manager or the
 * Worker can run on a model of this project's own in place of the app
 * default; the model ladder, destination approvals and reasoning still apply.
 */
import { type CatalogProfile, type ExecutionRole, roleUnavailableReason } from "@shared/roles";
import type { ProjectPolicy } from "@shared/types";

const PROJECT_MODEL_USAGE = "Usage: /project-model [manager|worker] [profile|default]";

const ROLE: Record<string, { field: "managerModel" | "workerModel"; role: ExecutionRole }> = {
  manager: { field: "managerModel", role: "manager" },
  worker: { field: "workerModel", role: "interactive" },
};

/** A profile Poundlock serves, by any name `/role` and `/project-model` accept. */
export function matchProfile(catalog: CatalogProfile[], wanted: string): CatalogProfile {
  const found = catalog.find(
    (profile) =>
      profile.name === wanted ||
      profile.profileId === wanted ||
      profile.id === wanted ||
      profile.aliases.includes(wanted),
  );
  if (!found)
    throw new Error(`No profile named ${wanted}. Run /models to see what is being served.`);
  return found;
}

export function projectModelCommand(
  policy: ProjectPolicy,
  args: string,
  catalog: CatalogProfile[],
): { policy?: ProjectPolicy; notice: string } {
  const [roleName = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const wanted = rest.join(" ");
  // Stored by profile id; shown by the name /models lists.
  const current = (field: "managerModel" | "workerModel") => {
    const stored = policy[field];
    if (!stored) return "the app default";
    return (
      catalog.find((profile) => profile.profileId === stored || profile.id === stored)?.name ??
      stored
    );
  };
  if (!roleName)
    return {
      notice: `This project's Manager: ${current("managerModel")}. Worker: ${current("workerModel")}.`,
    };
  const target = ROLE[roleName];
  if (!target || !wanted) throw new Error(PROJECT_MODEL_USAGE);
  if (wanted === "default")
    return {
      policy: { ...policy, [target.field]: target.field === "managerModel" ? "" : undefined },
      notice: `This project's ${roleName} now uses the app default.`,
    };
  const chosen = matchProfile(catalog, wanted);
  const unavailable = roleUnavailableReason(chosen, target.role);
  if (unavailable) throw new Error(`${chosen.name} cannot serve ${roleName}: ${unavailable}.`);
  return {
    policy: { ...policy, [target.field]: chosen.profileId ?? chosen.id },
    notice: `This project's ${roleName} now runs on ${chosen.name} (${chosen.dataDestination ?? "unknown"}).`,
  };
}
