/**
 * Worker commands as they were meant, before they are approved and run.
 *
 * Mainly: drop directory changes that point where a command already runs.
 * Workers write `cd <project> && git log` and `git -C <project> log` even
 * though every command starts in the project. Approval and saved exceptions
 * match the exact command, so each spelling of the same thing asked again.
 * Only a path that resolves to the working directory is removed; anything
 * else, including `~` and variables, is left for the user to see.
 */

import { basename, resolve } from "node:path";

/** A quoted or plain path with nothing the shell would expand. */
const PATH = String.raw`('[^']*'|"[^"$\`\\]*"|[^\s;&|<>()'"$\`\\~*?]+)`;
const LEADING_CD = new RegExp(String.raw`^\s*cd\s+${PATH}\s*(?:&&|;)\s*`);
const GIT_DIR = new RegExp(String.raw`(^|[\s;&|(])git\s+-C\s+${PATH}(?=\s)`, "g");

function unquote(value: string): string {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function isCwd(path: string, cwd: string): boolean {
  return resolve(cwd, unquote(path)) === resolve(cwd);
}

/** A Bash command without a leading `cd <cwd>` or any `git -C <cwd>`. */
export function withoutRedundantCd(command: string, cwd: string): string {
  let result = command;
  for (let match = LEADING_CD.exec(result); match; match = LEADING_CD.exec(result)) {
    const rest = result.slice(match[0].length);
    if (!isCwd(match[1], cwd) || !rest.trim()) break;
    result = rest;
  }
  return result.replace(GIT_DIR, (whole, before: string, path: string) =>
    isCwd(path, cwd) ? `${before}git` : whole,
  );
}

function programName(program: string): string {
  return basename(program)
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * run_command arguments as the program should receive them.
 *
 * Workers often repeat the program as the first argument, as in an argv
 * array. `git git diff` fails, and a worker that sees the failure falls back
 * to raw Bash with a `cd` added in case the directory was the problem. Git's
 * `-C <cwd>` is dropped for the same reason as `cd <cwd>` above.
 */
export function normalizedArguments(program: string, args: string[], cwd: string): string[] {
  const name = programName(program);
  const rest = args[0] !== undefined && programName(args[0]) === name ? args.slice(1) : args;
  if (name.startsWith("swift")) return withoutNestedSandbox(name, rest);
  if (name !== "git" || rest[0] !== "-C" || rest[1] === undefined || !isCwd(rest[1], cwd))
    return rest;
  return rest.slice(2);
}

const SWIFTPM_SUBCOMMANDS = new Set(["build", "test", "run", "package"]);
/** Subcommands that compile, whose macro plugins the compiler also sandboxes. */
const SWIFTPM_COMPILING = new Set(["build", "test", "run"]);

/**
 * SwiftPM with its own sandboxes turned off. It compiles every manifest, and
 * the compiler runs every macro plugin (Swift Testing's @Test among them),
 * under sandbox-exec, which macOS refuses inside Dispatch's sandbox
 * ("sandbox_apply: Operation not permitted"), so no Swift package built.
 */
function withoutNestedSandbox(name: string, args: string[]): string[] {
  const direct = name.replace(/^swift-/, "");
  const subcommand = name === "swift" ? args[0] : SWIFTPM_SUBCOMMANDS.has(direct) ? direct : "";
  if (!subcommand || !SWIFTPM_SUBCOMMANDS.has(subcommand)) return args;
  const flags = [
    ...(args.includes("--disable-sandbox") ? [] : ["--disable-sandbox"]),
    ...(SWIFTPM_COMPILING.has(subcommand) && !args.includes("-disable-sandbox")
      ? ["-Xswiftc", "-disable-sandbox"]
      : []),
  ];
  return name === "swift" ? [args[0], ...flags, ...args.slice(1)] : [...flags, ...args];
}
