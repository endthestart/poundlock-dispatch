/**
 * `/websearch`: Project settings → Network → "Web search for the manager and
 * Planner" in the app (ADR 017). It needs Internet on, and searches only once
 * a search engine is set up.
 */
import type { ProjectPolicy } from "@shared/types";
import { projectWebSearch, withSwitch } from "@shared/web-search";

export const WEB_SEARCH_USAGE = "Usage: /websearch [on|off], or /websearch engine <address|none>";

export function webSearchCommand(
  policy: ProjectPolicy,
  wanted: string | undefined,
  engineUrl: string | undefined,
): { policy?: ProjectPolicy; notice: string } {
  const where = engineUrl
    ? `Searches go through your search engine at ${engineUrl}.`
    : "No search engine is set up yet (/websearch engine <address>), so nothing is searched.";
  const said = (on: boolean) =>
    `Web search for the manager and Planner: ${on ? `on. ${where}` : "off."}`;
  if (!wanted) return { notice: said(projectWebSearch(policy)) };
  if (wanted !== "on" && wanted !== "off") throw new Error(WEB_SEARCH_USAGE);
  const on = wanted === "on";
  if (on && !withSwitch(policy, {}).internet)
    throw new Error("Web search needs Internet on: /network internet or /network both first.");
  return {
    policy: { ...policy, network: withSwitch(policy, { webSearch: on }) },
    notice: said(on),
  };
}
