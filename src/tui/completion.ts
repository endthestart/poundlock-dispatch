/**
 * `dispatch completion <fish|zsh|bash>`: a completion script for the shell,
 * printed for the user to load. It completes the subcommands and their
 * commands, and leaves anything else to the shell's own folder completion.
 */

export const COMPLETION_USAGE = "Usage: dispatch completion <fish|zsh|bash>";

/** `dispatch autopilot <command>`, as `parseAutoArgs` takes them. */
export const AUTOPILOT_COMMANDS = [
  "start",
  "status",
  "watch",
  "stop",
  "message",
  "resume",
  "export",
  "merge",
  "report",
  "drop",
  "clean",
  "list",
  "eval-planner",
] as const;

/** `dispatch jobs <command>`, as `parseJobsArgs` takes them. */
export const JOBS_COMMANDS = ["probe", "submit", "watch", "patch", "cancel"] as const;

const TOP = ["autopilot", "jobs", "completion"];
const FLAGS = ["--git", "--branch", "--account", "--json", "--help", "--version"];
const SHELLS = ["fish", "zsh", "bash"];

function fish(): string {
  const first = "__fish_use_subcommand";
  const after = (word: string) => `__fish_seen_subcommand_from ${word}`;
  return [
    "complete -c dispatch -f -n '__fish_use_subcommand' -a '(__fish_complete_directories)'",
    ...TOP.map((word) => `complete -c dispatch -f -n '${first}' -a ${word}`),
    ...FLAGS.map((flag) => `complete -c dispatch -n '${first}' -l ${flag.slice(2)}`),
    `complete -c dispatch -f -n '${after("autopilot")}' -a '${AUTOPILOT_COMMANDS.join(" ")}'`,
    `complete -c dispatch -n '${after("autopilot")}' -l dir -r -a '(__fish_complete_directories)'`,
    `complete -c dispatch -f -n '${after("jobs")}' -a '${JOBS_COMMANDS.join(" ")}'`,
    `complete -c dispatch -f -n '${after("completion")}' -a '${SHELLS.join(" ")}'`,
  ].join("\n");
}

/** One completion function both bash and zsh (through bashcompinit) run. */
function bash(): string {
  return `_dispatch() {
  local current="\${COMP_WORDS[COMP_CWORD]}" first="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${[...TOP, ...FLAGS].join(" ")}" -- "$current") $(compgen -d -- "$current"))
    return
  fi
  case "$first" in
    autopilot|auto)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=($(compgen -W "${AUTOPILOT_COMMANDS.join(" ")}" -- "$current"))
      else
        COMPREPLY=($(compgen -W "--dir --help" -- "$current") $(compgen -d -- "$current"))
      fi ;;
    jobs) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "${JOBS_COMMANDS.join(" ")}" -- "$current")) ;;
    completion) COMPREPLY=($(compgen -W "${SHELLS.join(" ")}" -- "$current")) ;;
    *) COMPREPLY=($(compgen -d -- "$current")) ;;
  esac
}
complete -F _dispatch dispatch`;
}

export function completionScript(shell: string | undefined): string {
  if (shell === "fish") return `${fish()}\n`;
  if (shell === "bash") return `${bash()}\n`;
  if (shell === "zsh") return `autoload -U +X bashcompinit && bashcompinit\n${bash()}\n`;
  throw new Error(COMPLETION_USAGE);
}
