/**
 * `/fix-rounds`: Project settings → "Fix rounds per task" in the app. How
 * many times a task whose checks fail is sent back to its worker before it
 * stops; `default` follows the app's setting.
 */
import { fixRoundsPerTask, MAX_FIX_ROUNDS_SETTING } from "@shared/policy-limits";
import type { ProjectPolicy } from "@shared/types";

export const FIX_ROUNDS_USAGE = `Usage: /fix-rounds [0-${MAX_FIX_ROUNDS_SETTING}|default]`;

export function fixRoundsCommand(
  policy: ProjectPolicy,
  wanted: string | undefined,
  appDefault: number | undefined,
): { policy?: ProjectPolicy; notice: string } {
  const said = (override: number | undefined) =>
    `Fix rounds per task: ${fixRoundsPerTask(override, appDefault)}${override === undefined ? " (the app default)" : ""}.`;
  if (!wanted) return { notice: said(policy.fixRoundsPerTask) };
  if (wanted === "default")
    return { policy: { ...policy, fixRoundsPerTask: undefined }, notice: said(undefined) };
  const rounds = /^\d+$/.test(wanted) ? Number.parseInt(wanted, 10) : -1;
  if (rounds < 0 || rounds > MAX_FIX_ROUNDS_SETTING) throw new Error(FIX_ROUNDS_USAGE);
  return { policy: { ...policy, fixRoundsPerTask: rounds }, notice: said(rounds) };
}
