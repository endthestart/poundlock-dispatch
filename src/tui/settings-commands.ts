/**
 * The commands for the desktop app's Settings pages that apply to every
 * project on this computer: Permissions, the model ladder, the manager on
 * this computer, Integrations and Appearance.
 */
import { type CommandDef, firstWordCompletions } from "./command-def.js";

export const SETTINGS_COMMAND_DEFS: CommandDef[] = [
  {
    name: "/permissions",
    description:
      "The app default for worker actions and fix rounds, the approval reviewer, and this project's saved exact actions.",
    argumentHint:
      "[default <mode> | fix-rounds <n> | reviewer <profile|auto> | rules | allow <command> | forget <n>]",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, [
        "default",
        "fix-rounds",
        "reviewer",
        "qualify",
        "unqualify",
        "rules",
        "allow",
        "allow-edit",
        "forget",
      ]),
  },
  {
    name: "/ladder",
    description:
      "The model ladder: stronger models a stuck task may move up to, and when that asks.",
    argumentHint:
      "[add <profile> | remove <rung> | up <rung> | down <rung> | ask | standing | limit <n>]",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, [
        "add",
        "remove",
        "up",
        "down",
        "ask",
        "standing",
        "limit",
      ]),
  },
  {
    name: "/local-manager",
    description:
      "Run the Project Manager on a model server on this computer; workers still use Poundlock.",
    argumentHint: "[on <model> [address] [--context <n>] [--output <n>] | off]",
  },
  {
    name: "/accounts",
    description: "GitHub and Gitea accounts for private repositories, pushing and pull requests.",
    argumentHint: "[github <username> [host] | gitea <username> [address] | remove <github|gitea>]",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, ["github", "gitea", "remove"]),
  },
  {
    name: "/appearance",
    description: "The theme, the bell when a project needs you, and the chips beside the composer.",
    argumentHint: "[theme <name> | notify <on|off> | chip <budget|context> <on|off>]",
    getArgumentCompletions: (argumentText) =>
      firstWordCompletions(argumentText, ["theme", "notify", "chip"]),
  },
];
