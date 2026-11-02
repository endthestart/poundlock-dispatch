/**
 * `/ladder`: Settings → Model ladder in the app. The ordered, stronger models
 * a stuck task may move to after the base worker, whether each move asks, and
 * how many moves to an external provider a run may make.
 */
import { type EscalationSettings, escalationSettings } from "@shared/escalation";
import {
  bindingForProfile,
  type CatalogProfile,
  catalogMatchesBinding,
  hasUse,
  profileDisplayName,
  profileRouteLabel,
  type RoleBinding,
} from "@shared/roles";
import type { AppStateView } from "@shared/types";
import { matchProfile } from "./project-model.js";

const LADDER_USAGE = [
  "Usage: /ladder, or /ladder with one of:",
  "  add <profile>   remove <rung>   up <rung>   down <rung>",
  "  ask   standing   limit <1-20>",
].join("\n");

const MODE = {
  ask: "ask for each move up the ladder",
  standing: "standing authorization for this list, every project on this connection",
} as const;

type Connection = AppStateView["connection"];

function rungLine(binding: RoleBinding, options: CatalogProfile[], connection: Connection): string {
  const profile = catalogMatchesBinding(options, binding);
  if (!profile) return `${binding.profileName} · not currently advertised`;
  const destination =
    connection.profiles?.[profile.profileId ?? profile.id]?.approvedDestination ??
    profile.dataDestination;
  const context = profile.context_tokens
    ? `${profile.context_tokens.toLocaleString()} tokens context`
    : "context limit not reported";
  return `${profileDisplayName(profile)} · ${profileRouteLabel({ ...profile, dataDestination: destination })} · ${context}`;
}

function ladderLines(
  ladder: EscalationSettings,
  options: CatalogProfile[],
  connection: Connection,
): string {
  const base = connection.roles.interactive;
  return [
    `Base worker (rung 0): ${base ? rungLine(base, options, connection) : "none; choose one with /role worker"}`,
    ...(ladder.profiles.length
      ? ladder.profiles.map(
          (binding, index) => `Rung ${index + 1}: ${rungLine(binding, options, connection)}`,
        )
      : ["No further rungs: /ladder add <profile>."]),
    `Moving up: ${MODE[ladder.mode]}.`,
    `At most ${ladder.maxTransitionsPerRun} moves to an external provider per run.`,
  ].join("\n");
}

function rungIndex(ladder: EscalationSettings, wanted: string): number {
  const index = /^\d+$/.test(wanted) ? Number.parseInt(wanted, 10) - 1 : -1;
  if (index < 0 || index >= ladder.profiles.length)
    throw new Error(`There is no rung ${wanted}. ${LADDER_USAGE}`);
  return index;
}

function changed(
  ladder: EscalationSettings,
  action: string,
  wanted: string,
  options: CatalogProfile[],
): EscalationSettings {
  const profiles = [...ladder.profiles];
  if (action === "add") {
    const profile = matchProfile(options, wanted);
    if (profiles.some((binding) => catalogMatchesBinding([profile], binding)))
      throw new Error(`${profile.name} is already a rung.`);
    return { ...ladder, profiles: [...profiles, bindingForProfile(profile)] };
  }
  if (action === "remove")
    return { ...ladder, profiles: profiles.filter((_, at) => at !== rungIndex(ladder, wanted)) };
  if (action === "up" || action === "down") {
    const index = rungIndex(ladder, wanted);
    const other = index + (action === "up" ? -1 : 1);
    if (other < 0 || other >= profiles.length)
      throw new Error(`Rung ${wanted} is already at the ${action === "up" ? "top" : "bottom"}.`);
    [profiles[index], profiles[other]] = [profiles[other], profiles[index]];
    return { ...ladder, profiles };
  }
  if ((action === "ask" || action === "standing") && !wanted) return { ...ladder, mode: action };
  if (action === "limit" && /^\d+$/.test(wanted)) {
    const limit = Number.parseInt(wanted, 10);
    if (limit >= 1 && limit <= 20) return { ...ladder, maxTransitionsPerRun: limit };
  }
  throw new Error(LADDER_USAGE);
}

/** What the command changes, if anything, and what to say. */
export function ladderCommand(
  connection: Connection,
  catalog: CatalogProfile[],
  args: string,
): { ladder?: EscalationSettings; notice: string } {
  const options = catalog.filter((item) => !hasUse(item, "completion"));
  const ladder = escalationSettings(connection.escalation, connection.roles);
  const [action = ""] = args.trim().split(/\s+/);
  if (!action) return { notice: ladderLines(ladder, options, connection) };
  const next = changed(ladder, action, args.trim().slice(action.length).trim(), options);
  return { ladder: next, notice: ladderLines(next, options, connection) };
}
