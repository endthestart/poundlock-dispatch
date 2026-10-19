import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

/** Keep application credentials out of host Git and its child processes. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
  };
}

/**
 * Command-line settings that outrank a repository's own configuration, so none
 * of the helper programs it could name runs: no fsmonitor, pager or signature
 * check. A diff also gets `--no-ext-diff --no-textconv`. A folder unpacked from an archive brings its own
 * `.git/config` (L22). `git_inspect` adds its own on top.
 */
export const HELPERS_OFF = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "color.ui=false",
  "log.showSignature=false",
];

/** Git subcommands that can run a repository's filter drivers on files in the folder. */
const FILTERING = new Set(["status", "diff", "add", "stash", "checkout", "commit", "restore"]);

/** Where the subcommand is, past global options such as `-c key=value` and `--git-dir <dir>`. */
function subcommandAt(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace"].includes(arg)) i++;
    else if (!arg.startsWith("-")) return i;
  }
  return -1;
}

function subcommand(args: string[]): string | undefined {
  return args[subcommandAt(args)];
}

/** A diff never runs the repository's external diff or text conversion programs. */
function withoutDiffHelpers(args: string[]): string[] {
  const at = subcommandAt(args);
  if (!["diff", "show"].includes(args[at] ?? "")) return args;
  return [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)];
}

/**
 * Settings that switch off each filter driver the repository's own configuration
 * names. Filters are switched off by name, so the names are read first;
 * reading configuration runs nothing.
 */
async function filtersOff(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  if (!FILTERING.has(subcommand(args) ?? "")) return [];
  const globals: string[] = [];
  for (let i = 0; i < args.length && args[i].startsWith("-"); i++) {
    if (["--git-dir", "--work-tree", "-C"].includes(args[i])) globals.push(args[i], args[++i]);
    else if (args[i] === "-c") i++;
  }
  const listed = await spawnGit(
    cwd,
    // The repository's own configuration and what it includes; the owner's
    // global filters (Git LFS, say) are theirs and stay on.
    [...globals, "config", "--local", "--includes", "--name-only", "--get-regexp", "^filter\\."],
    env,
  ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const names = new Set(
    listed.stdout
      .split("\n")
      .map((line) => /^filter\.(.+)\.[^.]+$/.exec(line.trim())?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  return [...names].flatMap((name) =>
    ["clean", "smudge", "process"].flatMap((part) => ["-c", `filter.${name}.${part}=`]),
  );
}

export async function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = gitEnvironment(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnGit(
    cwd,
    [
      "-c",
      "user.email=dispatch@local",
      "-c",
      "user.name=Poundlock Dispatch",
      ...HELPERS_OFF.flatMap((setting) => ["-c", setting]),
      ...(await filtersOff(cwd, args, env)),
      ...withoutDiffHelpers(args),
    ],
    env,
  );
}

function spawnGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_TEMPLATE_DIR: env.GIT_TEMPLATE_DIR ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function isCommitId(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref.trim());
}

export function assertHttpsGitUrl(repository: string): string {
  const url = repository.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Use an HTTPS repository URL, such as https://github.com/org/repo.git.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      "Use an HTTPS repository URL. SSH and local paths are not accepted from this form.",
    );
  }
  return url;
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return (
      value
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        ?.toLowerCase() ?? ""
    );
  }
}

export function forgeHostMatches(repository: string, accountHost: string): boolean {
  const repoHost = hostnameOf(repository);
  const account = hostnameOf(accountHost);
  if (!repoHost || !account) return false;
  if (repoHost === account) return true;
  return (
    (repoHost === "github.com" && account === "www.github.com") ||
    (repoHost === "www.github.com" && account === "github.com")
  );
}

export async function gitRemoteUrl(folder: string): Promise<string | undefined> {
  const top = await runGit(folder, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return undefined;
  try {
    const gitRoot = await realpath(top.stdout.trim());
    const requested = await realpath(folder);
    if (gitRoot !== requested) return undefined;
  } catch {
    return undefined;
  }
  const result = await runGit(folder, ["remote", "get-url", "origin"]);
  if (result.code !== 0) return undefined;
  const url = result.stdout.trim();
  return url || undefined;
}
