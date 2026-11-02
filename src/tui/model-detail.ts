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
): string[] {
  const bound = new Map<string, string[]>();
  for (const [role, binding] of Object.entries(roles))
    if (binding) bound.set(binding.profileId, [...(bound.get(binding.profileId) ?? []), role]);
  const nameWidth = Math.max(...catalog.map((profile) => profile.name.length)) + 2;
  return catalog.map((profile) => {
    const where = profile.dataDestination ?? "unknown";
    const held = bound.get(profile.profileId ?? profile.id);
    return `  ${profile.name.padEnd(nameWidth)}${where.padEnd(18)}${held ? `← ${held.join(", ")}` : ""}`.trimEnd();
  });
}
