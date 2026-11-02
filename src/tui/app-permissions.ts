/**
 * `/permissions`: Settings → Permissions in the app. The app default for
 * worker actions and fix rounds, what each project ends up with, the action
 * approval reviewer, and this project's saved exact-action permissions.
 */
import { isAbsolute, resolve } from "node:path";
import {
  effectiveToolTrust,
  type PermissionSettings,
  type SavedPermission,
  TOOL_TRUST_MODES,
  toolTrustLabel,
} from "@shared/permissions";
import { fixRoundsPerTask, MAX_FIX_ROUNDS_SETTING } from "@shared/policy-limits";
import type { CatalogProfile } from "@shared/roles";
import type { ProjectRecord } from "@shared/types";
import { matchProfile } from "./project-model.js";

const PERMISSIONS_USAGE = [
  "Usage: /permissions, or /permissions with one of:",
  `  default <${TOOL_TRUST_MODES.map((mode) => mode.id).join("|")}>   fix-rounds <0-${MAX_FIX_ROUNDS_SETTING}>`,
  "  reviewer <profile|auto>   qualify <profile>   unqualify <profile>",
  "  rules   allow <command>   allow-edit <file>   forget <number>",
].join("\n");

export interface PermissionsContext {
  settings: PermissionSettings;
  projects: ProjectRecord[];
  catalog: CatalogProfile[];
  /** The open project, whose saved exact actions `rules`, `allow` and `forget` work on. */
  project: ProjectRecord;
}

type Outcome = { settings?: PermissionSettings; notice: string };

const profileKey = (profile: CatalogProfile) => profile.profileId ?? profile.id;

function overview({ settings, projects }: PermissionsContext): string {
  const listed = projects.filter((project) => !project.archived);
  return [
    `App default for worker actions: ${toolTrustLabel(settings.defaultMode)}.`,
    `Fix rounds per task: ${fixRoundsPerTask(undefined, settings.fixRoundsPerTask)}.`,
    ...(listed.length ? ["By project:"] : []),
    ...listed.map(
      (project) =>
        `  ${project.name}: ${toolTrustLabel(effectiveToolTrust(project.policy.toolTrust, settings))} (${
          project.policy.toolTrust ? "project override, /trust" : "app default"
        })`,
    ),
    reviewerLine(settings),
  ].join("\n");
}

function reviewerLine(settings: PermissionSettings): string {
  const qualified = settings.reviewer?.qualifiedProfileIds ?? [];
  return `Approval reviewer (Approve for me only): ${
    settings.reviewer?.profileId ?? "automatic, qualified models only"
  }. Qualified: ${qualified.length ? qualified.join(", ") : "none"}.`;
}

function rulesLines(rules: SavedPermission[]): string {
  if (!rules.length) return "No saved permissions for this project.";
  return [
    "Saved exact actions for this project:",
    ...rules.map(
      (rule, index) =>
        `${index + 1}. ${rule.kind === "bash" ? "Run" : "Edit"} ${rule.action} (in ${rule.cwd})`,
    ),
  ].join("\n");
}

function reviewer(context: PermissionsContext, action: string, wanted: string): Outcome {
  const { settings, catalog } = context;
  const current = settings.reviewer ?? {};
  const qualified = current.qualifiedProfileIds ?? [];
  const save = (reviewerSettings: PermissionSettings["reviewer"]) => {
    const next = { ...settings, reviewer: reviewerSettings };
    return { settings: next, notice: reviewerLine(next) };
  };
  if (action === "reviewer")
    return save({
      ...current,
      profileId: wanted === "auto" ? undefined : profileKey(matchProfile(catalog, wanted)),
    });
  const id = profileKey(matchProfile(catalog, wanted));
  if (action === "qualify")
    return save({ ...current, qualifiedProfileIds: [...new Set([...qualified, id])] });
  return save({ ...current, qualifiedProfileIds: qualified.filter((item) => item !== id) });
}

function rules(context: PermissionsContext, action: string, wanted: string): Outcome {
  const { settings, project } = context;
  const current = settings.grants?.[project.id] ?? [];
  const save = (next: SavedPermission[]) => ({
    settings: { ...settings, grants: { ...settings.grants, [project.id]: next } },
    notice: rulesLines(next),
  });
  if (action === "rules") {
    if (wanted) throw new Error(PERMISSIONS_USAGE);
    return { notice: rulesLines(current) };
  }
  if (action === "forget") {
    const index = /^\d+$/.test(wanted) ? Number.parseInt(wanted, 10) - 1 : -1;
    if (index < 0 || index >= current.length)
      throw new Error(`There is no saved permission ${wanted}. ${rulesLines(current)}`);
    return save(current.filter((_, at) => at !== index));
  }
  if (project.source.kind !== "local_folder")
    throw new Error("Saved exact actions need a folder project.");
  const cwd = project.source.originalPath;
  const rule: SavedPermission =
    action === "allow"
      ? { kind: "bash", action: wanted, cwd }
      : { kind: "write", action: isAbsolute(wanted) ? wanted : resolve(cwd, wanted), cwd };
  if (current.some((item) => item.kind === rule.kind && item.action === rule.action))
    throw new Error(`${rule.action} is already saved. ${rulesLines(current)}`);
  return save([...current, rule]);
}

/** What the command changes, if anything, and what to say. */
export function permissionsCommand(context: PermissionsContext, args: string): Outcome {
  const [action = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const wanted = args.trim().slice(action.length).trim();
  const { settings } = context;
  if (!action) return { notice: overview(context) };
  if (action === "default" && rest.length === 1) {
    const mode = TOOL_TRUST_MODES.find((item) => item.id === wanted);
    if (!mode) throw new Error(PERMISSIONS_USAGE);
    const next = { ...settings, defaultMode: mode.id };
    return { settings: next, notice: overview({ ...context, settings: next }) };
  }
  if (action === "fix-rounds" && rest.length === 1) {
    const rounds = /^\d+$/.test(wanted) ? Number.parseInt(wanted, 10) : -1;
    if (rounds < 0 || rounds > MAX_FIX_ROUNDS_SETTING) throw new Error(PERMISSIONS_USAGE);
    const next = { ...settings, fixRoundsPerTask: rounds };
    return { settings: next, notice: `Fix rounds per task: ${rounds}. A project can override it.` };
  }
  if (["reviewer", "qualify", "unqualify"].includes(action) && wanted)
    return reviewer(context, action, wanted);
  if (action === "rules" || (["allow", "allow-edit", "forget"].includes(action) && wanted))
    return rules(context, action, wanted);
  throw new Error(PERMISSIONS_USAGE);
}
