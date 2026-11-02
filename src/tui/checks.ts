/**
 * `/checks`: the project's verification commands, Project settings →
 * "Verification commands" in the app. Each one decides whether a task's work
 * is accepted; with none, Dispatch uses the checks the repository declares.
 */
import type { ProjectPolicy } from "@shared/types";

const CHECKS_USAGE =
  "Usage: /checks, /checks add <command>, /checks remove <number>, /checks clear or /checks mutation [on|off]";

/** Project settings' mutation check: break the task's new code a little and see whether a check notices. */
function mutationCheck(
  policy: ProjectPolicy,
  wanted: string,
): { policy?: ProjectPolicy; notice: string } {
  const said = (on: boolean) =>
    on
      ? "Mutation check: on. Before accepting a task, Dispatch flips up to two conditions in its new code and reruns the checks; a change no check notices is sent back once."
      : "Mutation check: off.";
  if (!wanted) return { notice: said(policy.mutationCheck !== false) };
  if (wanted !== "on" && wanted !== "off") throw new Error(CHECKS_USAGE);
  const on = wanted === "on";
  return { policy: { ...policy, mutationCheck: on ? undefined : false }, notice: said(on) };
}

/** What the command changes, if anything, and what to say. */
export function checksCommand(
  policy: ProjectPolicy,
  args: string,
): { policy?: ProjectPolicy; notice: string } {
  const commands = policy.verification.commands;
  const [action = "", ...rest] = args.trim().split(/\s+/);
  const argument = args.trim().slice(action.length).trim();
  const withCommands = (next: string[]) => ({
    ...policy,
    verification: { ...policy.verification, commands: next },
  });
  const listed = (next: string[]) =>
    next.length
      ? `Checks:\n${next.map((command, index) => `${index + 1}. ${command}`).join("\n")}`
      : "No checks of the project's own: Dispatch uses the checks the repository declares after setup, and records what it runs.";
  if (!action) return { notice: listed(commands) };
  if (action === "add" && argument) {
    if (commands.includes(argument)) throw new Error(`${argument} is already a check.`);
    const next = [...commands, argument];
    return { policy: withCommands(next), notice: listed(next) };
  }
  if (action === "remove" && rest.length === 1 && /^\d+$/.test(rest[0])) {
    const index = Number.parseInt(rest[0], 10) - 1;
    if (index < 0 || index >= commands.length)
      throw new Error(`There is no check ${rest[0]}. ${listed(commands)}`);
    const next = commands.filter((_, at) => at !== index);
    return { policy: withCommands(next), notice: listed(next) };
  }
  if (action === "clear" && !argument) return { policy: withCommands([]), notice: listed([]) };
  if (action === "mutation" && rest.length <= 1) return mutationCheck(policy, rest[0] ?? "");
  throw new Error(CHECKS_USAGE);
}
