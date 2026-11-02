/**
 * `/models <profile>`: what the app's role page says about the chosen model —
 * where its data goes, how it is reached, thinking, the model actually
 * serving it and its price, and whether Poundlock took it out of service.
 * `/models <profile> destination …` corrects the destination Poundlock reports,
 * as the app's "Reported destination override" does.
 */
import {
  type CatalogProfile,
  destinationLabel,
  type ExecutionRole,
  effectiveDestination,
  endpointKindLabel,
  pricingSourceLabel,
} from "@shared/roles";
import type { DataDestination } from "@shared/types";

export const DESTINATION_USAGE =
  "Usage: /models <profile> destination <own|external|reported>: own infrastructure, an external provider, or what Poundlock reports";

const OVERRIDE: Record<string, DataDestination | undefined> = {
  own: "operator_network",
  external: "external",
  reported: undefined,
};

/** A role as the app names it: the interactive role is the Worker. */
export function roleName(role: ExecutionRole): string {
  return role === "interactive" ? "worker" : role;
}

/** The override `destination <own|external|reported>` names; `reported` clears it. */
export function destinationOverride(wanted: string): DataDestination | undefined {
  if (!Object.hasOwn(OVERRIDE, wanted)) throw new Error(DESTINATION_USAGE);
  return OVERRIDE[wanted];
}

export function modelDetailLines(profile: CatalogProfile, override?: string): string[] {
  const pricing = profile.pricing;
  const destination = effectiveDestination(profile.dataDestination, override) as DataDestination;
  return [
    `${profile.name}`,
    `  Destination: ${destinationLabel(destination)} (${override ? "your override; it corrects missing server metadata and never routes" : "reported by Poundlock"})`,
    `  Transport: ${endpointKindLabel(profile.endpointKind)}`,
    `  Thinking: ${profile.thinking === "off" ? "off, for every client" : "the model's own default"}`,
    ...(profile.servedModel ? [`  Served by ${profile.servedModel}`] : []),
    ...(pricing
      ? [
          `  About $${pricing.inputPerMtok.toFixed(2)} in / $${pricing.outputPerMtok.toFixed(2)} out per million tokens (${pricingSourceLabel(pricing.source)}; an estimate, not a bill)`,
        ]
      : []),
    ...(profile.status === "disabled"
      ? [
          `  Poundlock took this profile out of service: ${profile.disabled?.reason ?? "no reason given"}`,
        ]
      : []),
  ];
}

/** One `/models` row per profile: name, destination, and every role bound to it, in columns that fit the longest name. */
export function modelListRows(
  catalog: CatalogProfile[],
  roles: Record<string, { profileId: string } | undefined>,
  width: number,
): string[] {
  const bound = new Map<string, string[]>();
  for (const [role, binding] of Object.entries(roles))
    if (binding)
      bound.set(binding.profileId, [
        ...(bound.get(binding.profileId) ?? []),
        roleName(role as ExecutionRole),
      ]);
  const rows = catalog.map((profile) => {
    const held = bound.get(profile.profileId ?? profile.id);
    return {
      name: profile.name,
      where: destinationLabel(profile.dataDestination),
      held: held ? `← ${held.join(", ")}` : "",
    };
  });
  const nameWidth = Math.max(...rows.map((row) => row.name.length)) + 2;
  const whereWidth = Math.max(...rows.map((row) => row.where.length)) + 2;
  const table = rows.map((row) =>
    `  ${row.name.padEnd(nameWidth)}${row.where.padEnd(whereWidth)}${row.held}`.trimEnd(),
  );
  if (table.every((line) => line.length <= width)) return table;
  // Too narrow for columns: the details go under the name rather than wrap.
  return rows.flatMap((row) => [`  ${row.name}`, `      ${row.where} ${row.held}`.trimEnd()]);
}
