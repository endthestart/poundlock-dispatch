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
import type { TranscriptDensity } from "@shared/live-work-view";
import { TOOL_TRUST_MODES } from "@shared/permissions";
import { EXECUTION_ROLES } from "@shared/roles";
import { REASONING_LEVELS } from "@shared/types";
import { type CommandDef, firstWordCompletions } from "./command-def.js";
import { roleName } from "./model-detail.js";
import { SETTINGS_COMMAND_DEFS } from "./settings-commands.js";

/** `/role <role> <profile>`: complete the role, never the profile. */
export function roleArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  return firstWordCompletions(argumentText, EXECUTION_ROLES.map(roleName));
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

function networkArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  return firstWordCompletions(argumentText, Object.keys(NETWORK_CHOICES));
}

/** `/transcript`'s two settings, worded as the desktop app's Transcript chip words them. */
export const TRANSCRIPT_DENSITY: Record<TranscriptDensity, string> = {
  normal: "Normal. Each reply's steps folded, and one update between messages.",
  verbose: "Verbose. Every step and update, as it happened.",
};

export function isTranscriptDensity(value: string): value is TranscriptDensity {
  return Object.hasOwn(TRANSCRIPT_DENSITY, value);
}

function transcriptArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  return firstWordCompletions(argumentText, Object.keys(TRANSCRIPT_DENSITY));
}

/** `/grant <path> [read|write]`: complete the mode once a path is typed. */
export function grantArgumentCompletions(argumentText: string): AutocompleteItem[] | null {
  const spaceIndex = argumentText.indexOf(" ");
  if (spaceIndex === -1) return null;
  return firstWordCompletions(argumentText.slice(spaceIndex + 1), ["read", "write"]);
}

export const COMMAND_DEFS: CommandDef[] = [
  { name: "/help", description: "List these commands." },
  { name: "/board", description: "Show the plan and task board." },
  { name: "/setup", description: "Show connection and role setup." },
  {
    name: "/connect",
    description: "Set the Poundlock controller address and token, then test them.",
    argumentHint: "[address]",
  },
  { name: "/chat", description: "Return to the conversation." },
  {
    name: "/history",
    description: "Earlier conversations, plans and tasks that /new and /new-run set aside.",
  },
  {
    name: "/compact",
    description:
      "Summarise the manager's older messages to free up context. Instructions say what to keep.",
    argumentHint: "[instructions]",
  },
  { name: "/approve", description: "Approve the proposed plan and start the run." },
  {
    name: "/new",
    description: "New conversation: the manager starts fresh, and this one moves to History.",
  },
  {
    name: "/new-run",
    description: "Start a new run: clear the plan's approval and its tasks, keep the conversation.",
  },
  {
    name: "/task",
    description:
      "A task's evidence: attempts, checks and their output, the worker's report and the diff.",
    argumentHint: "<number> [attempt]",
  },
  {
    name: "/archive",
    description: "Hide this project from the list and close; its history is kept.",
  },
  {
    name: "/remove",
    description: "Delete Dispatch's records of this project and close. Never deletes the folder.",
  },
  {
    name: "/approve-models",
    description: "Re-approve the route Poundlock is serving now, after it changed.",
  },
  {
    name: "/models",
    description: "List the model profiles Poundlock is serving, or say more about one.",
    argumentHint: "[profile]",
  },
  {
    name: "/role",
    description: "Bind a role to a profile; with no profile, choose one from a list.",
    argumentHint: "<role> [profile]",
    getArgumentCompletions: roleArgumentCompletions,
  },
  {
    name: "/project-model",
    description: "This project's own Manager or Worker model, in place of the app default.",
    argumentHint: "[manager|worker] [profile|default]",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, ["manager", "worker"]),
  },
  {
    name: "/reasoning",
    description: "This conversation's manager reasoning.",
    argumentHint: "[setting|default]",
    getArgumentCompletions: reasoningArgumentCompletions,
  },
  {
    name: "/transcript",
    description: "How much of the work the conversation shows: normal or verbose.",
    argumentHint: "[normal|verbose]",
    getArgumentCompletions: transcriptArgumentCompletions,
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
    name: "/websearch",
    description:
      "Whether this project's manager and Planner may search the web (needs Internet on), and the search engine every project uses.",
    argumentHint: "[on|off] | engine <address|none>",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, ["on", "off", "engine"]),
  },
  {
    name: "/checks",
    description: "The commands that decide whether a task's work is accepted.",
    argumentHint: "[add <command> | remove <number> | clear | mutation [on|off]]",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, ["add", "remove", "clear", "mutation"]),
  },
  {
    name: "/fix-rounds",
    description: "How many times a task whose checks fail goes back to its worker.",
    argumentHint: "[0-5|default]",
  },
  ...SETTINGS_COMMAND_DEFS,
  {
    name: "/runtime",
    description: "The Node this project's workers use; they never inherit your shell PATH.",
    argumentHint: "[node <number|folder|none>]",
  },
  {
    name: "/repo-account",
    description: "Public clone only, or the GitHub or Gitea account saved with /accounts.",
    argumentHint: "[github|gitea|none]",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, ["github", "gitea", "none"]),
  },
  {
    name: "/grant",
    description: "Let this project use another folder.",
    argumentHint: "<path> [read|write]",
    getArgumentCompletions: grantArgumentCompletions,
  },
  { name: "/revoke", description: "Stop using a granted folder.", argumentHint: "<path>" },
  {
    name: "/grant-file",
    description: "Let the manager read one file that is otherwise excluded, such as a .env.",
    argumentHint: "<path>",
  },
  {
    name: "/revoke-file",
    description: "Take back a file /grant-file let the manager read.",
    argumentHint: "<path>",
  },
  {
    name: "/autopilot",
    description:
      "Autopilot: build the approved plan unattended in a container; results are verified, not reviewed.",
    argumentHint:
      "start [--image <name> …] | status | details | message <words> | stop [--now] | resume | export | hide",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, [
        "start",
        "status",
        "message",
        "stop",
        "resume",
        "export",
        "list",
        "details",
        "hide",
        "watch",
        "merge",
        "report",
        "drop",
        "clean",
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

/** Every command with its argument and what it does, for `/help`. */
export function commandHelp(): string {
  const heads = COMMAND_DEFS.map((def) =>
    def.argumentHint ? `${def.name} ${def.argumentHint}` : def.name,
  );
  const width = Math.max(...heads.map((head) => head.length)) + 2;
  return [
    "Commands (typing / completes them):",
    ...COMMAND_DEFS.map((def, index) => `  ${heads[index].padEnd(width)}${def.description}`),
  ].join("\n");
}
