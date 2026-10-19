/**
 * The command registry: one list that names every slash command, describes
 * it, and — where it is cheap and needs no network round trip — completes its
 * argument. `app.ts` builds each entry's `run` (it closes over `this`, the
 * one thing this file cannot have) but the shape, the descriptions and the
 * completions live here so they can be unit-tested with no TUI at all.
 *
 * Feeding this list into pi-tui's `CombinedAutocompleteProvider` is the whole
 * implementation of "typing / completes with descriptions" — the argument
 * hints and one-line descriptions below are exactly what the autocomplete
 * popover shows, because pi-tui reads the same fields from a `SlashCommand`.
 */
import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";
import { TOOL_TRUST_MODES } from "@shared/permissions";
import { EXECUTION_ROLES } from "@shared/roles";
import { REASONING_LEVELS } from "@shared/types";

/** A command entry, before `app.ts` attaches its handler. */
export interface CommandDef {
  /** Including the leading "/", so it matches `input.split(/\s+/)[0]` directly. */
  name: `/${string}`;
  description: string;
  argumentHint?: string;
  /**
   * `argumentText` is everything after the command name and one space — the
   * whole remainder, not just the word under the cursor (that is how pi-tui's
   * `CombinedAutocompleteProvider` calls it). A command with more than one
   * argument has to notice for itself which one is being typed.
   */
  getArgumentCompletions?: (argumentText: string) => AutocompleteItem[] | null;
}

function firstWordCompletions(
  argumentText: string,
  choices: readonly string[],
): AutocompleteItem[] | null {
  // Only the first argument is completed from a fixed list; a second word
  // means the user has moved on to something this file cannot guess (a
  // profile name, a path) without a network call or a directory read.
  if (argumentText.includes(" ")) return null;
  const matches = choices.filter((choice) => choice.startsWith(argumentText));
  return matches.length ? matches.map((choice) => ({ value: choice, label: choice })) : null;
}

/** `/role <role> <profile>`: complete the role, never the profile. */
export function roleArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  return firstWordCompletions(argumentText, EXECUTION_ROLES);
}

/** `/reasoning [setting|default]`. */
export function reasoningArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  return firstWordCompletions(argumentText, [...REASONING_LEVELS, "default"]);
}

/** `/trust [ask|assist|full|default]`. */
export function trustArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  return firstWordCompletions(argumentText, [
    ...TOOL_TRUST_MODES.map((mode) => mode.id),
    "default",
  ]);
}

/** `/network` takes one of the four switch settings (ADR 015). */
export const NETWORK_CHOICES = {
  both: { internet: true, localNetwork: true },
  internet: { internet: true, localNetwork: false },
  local: { internet: false, localNetwork: true },
  none: { internet: false, localNetwork: false },
} as const;

export function networkArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  return firstWordCompletions(argumentText, Object.keys(NETWORK_CHOICES));
}

/** `/grant <path> [read|write]`: complete the mode once a path is typed. */
export function grantArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  const spaceIndex = argumentText.indexOf(" ");
  if (spaceIndex === -1) return null;
  return firstWordCompletions(argumentText.slice(spaceIndex + 1), ["read", "write"]);
}

export const COMMAND_DEFS: CommandDef[] = [
  { name: "/board", description: "Show the plan and task board." },
  { name: "/setup", description: "Show connection and role setup." },
  {
    name: "/connect",
    description: "Set the Poundlock controller address and token, then test them.",
    argumentHint: "[address]",
  },
  { name: "/chat", description: "Return to the conversation." },
  {
    name: "/compact",
    description:
      "Summarise the manager's older messages to free up context. Instructions say what to keep.",
    argumentHint: "[instructions]",
  },
  { name: "/approve", description: "Approve the proposed plan and start the run." },
  {
    name: "/approve-models",
    description: "Re-approve the route Poundlock is serving now, after it changed.",
  },
  { name: "/models", description: "List the model profiles Poundlock is serving." },
  {
    name: "/role",
    description: "Bind a role to a profile.",
    argumentHint: "<role> <profile>",
    getArgumentCompletions: roleArgumentCompletions,
  },
  {
    name: "/reasoning",
    description: "This conversation's manager reasoning.",
    argumentHint: "[setting|default]",
    getArgumentCompletions: reasoningArgumentCompletions,
  },
  {
    name: "/trust",
    description: "This project's worker permissions.",
    argumentHint: "[ask|assist|full|default]",
    getArgumentCompletions: trustArgumentCompletions,
  },
  {
    name: "/network",
    description: "What this project's commands may reach: internet, local network, both or none.",
    argumentHint: "[both|internet|local|none]",
    getArgumentCompletions: networkArgumentCompletions,
  },
  {
    name: "/grant",
    description: "Let this project use another folder.",
    argumentHint: "<path> [read|write]",
    getArgumentCompletions: grantArgumentCompletions,
  },
  { name: "/revoke", description: "Stop using a granted folder.", argumentHint: "<path>" },
  {
    name: "/autopilot",
    description:
      "Autopilot: build the approved plan unattended in a container; results are verified, not reviewed.",
    argumentHint: "start --image <name> | status | stop [--now] | resume | export | hide",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, [
        "start",
        "status",
        "stop",
        "resume",
        "export",
        "list",
        "hide",
        "watch",
      ]),
  },
  { name: "/auto", description: "The same as /autopilot, for one more release." },
  { name: "/pause", description: "Pause the run." },
  { name: "/cancel", description: "Cancel the run." },
  { name: "/resume", description: "Resume the run." },
  { name: "/reopen", description: "Reopen a finished review." },
  {
    name: "/override",
    description: "Override and continue past a stop.",
    argumentHint: "<reason>",
  },
  {
    name: "/retry",
    description: "Give a stopped task a fresh allowance.",
    argumentHint: "[task]",
  },
  { name: "/quit", description: "Exit." },
];

/** `CommandDef` as the `SlashCommand` pi-tui's autocomplete provider wants. */
export function toSlashCommands(defs: readonly CommandDef[]): SlashCommand[] {
  return defs.map((def) => ({
    name: def.name.slice(1),
    description: def.description,
    argumentHint: def.argumentHint,
    getArgumentCompletions: def.getArgumentCompletions,
  }));
}
