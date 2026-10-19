/**
 * Read-only Git inspection for workers.
 *
 * A review needs history and diffs, and the general command sandbox cannot
 * give them: it denies `.git`, because repository config can hold credentials
 * and name helper programs, and Apple's /usr/bin/git is a shim that writes an
 * xcrun cache outside the sandbox. So this runs a fixed set of read-only
 * subcommands with validated arguments, the real git binary, repository
 * helpers switched off, and a sandbox that can read the repository but write
 * nothing in it and reach no network.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isWithin } from "@core/file-access";
import { HELPERS_OFF } from "@core/git";
import { approvedHostToolDirectories } from "@core/host-tools";
import ignore from "ignore";
import type { SandboxQualification, SandboxRequest } from "./sandbox.js";
import { assistCommandBoundary, wrapWithSandbox } from "./sandbox.js";
import { SENSITIVE_EXCLUSIONS } from "./sandbox-policy.js";

const run = promisify(execFile);

export const GIT_INSPECT_COMMANDS = ["status", "log", "show", "diff", "file"] as const;
export type GitInspectCommand = (typeof GIT_INSPECT_COMMANDS)[number];

export interface GitInspectInput {
  command: GitInspectCommand;
  /** log/diff: a range (`a..b`) or up to two revisions; show: one; file: exactly one. */
  revisions?: string[];
  /** Project-relative paths to limit to; file: exactly one. */
  paths?: string[];
  /** A per-file summary instead of the patch (log, show, diff). */
  stat?: boolean;
  /** log: how many commits (default 50, at most 500). */
  maxCount?: number;
  /** First output line to return, for paging through a long result. */
  offset?: number;
}

export interface GitInspectContext {
  projectRoot: string;
  /** The project's own exclusions, on top of the fixed sensitive ones. */
  excludedPatterns: string[];
  /** Where git may write its scratch files; never inside the project. */
  tmp: string;
  /** The general command sandbox's denies; `.git` is removed from them here. */
  deniedRead: string[];
  signal?: AbortSignal;
  qualifySandbox?: () => Promise<SandboxQualification>;
  /** Asked when no sandbox can contain git. Absent means refuse. */
  authorizeUncontained?: (display: string) => Promise<"allow" | "deny">;
  /** Test seam for the process runner. */
  exec?: typeof runGit;
}

/** How much of a result one call returns; the rest is paged by `offset`. */
const PAGE_CHARS = 12_000;
/** Git output beyond this is cut rather than held in memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** One side of a revision: a name, hash or relative ref, never an option. */
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^-]*$/;

/**
 * Pathspecs that keep secret files out of any patch, even when history
 * committed them. Names in a summary are fine; their content is not.
 */
const SECRET_PATHSPECS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "credentials.json",
  "*.secret.json",
  "auth.json",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".ssh/**",
  "secrets/**",
  ".kube/**",
  ".docker/config.json",
].map((pattern) => `:(exclude,glob)**/${pattern}`);

export function validRevision(value: string): boolean {
  const sides = value.includes("...")
    ? value.split("...")
    : value.includes("..")
      ? value.split("..")
      : [value];
  return sides.length <= 2 && sides.every((side) => REVISION.test(side) && !side.includes(".."));
}

function checkedPaths(input: GitInspectInput, ctx: GitInspectContext): string[] {
  const excluded = ignore().add([...SENSITIVE_EXCLUSIONS, ...ctx.excludedPatterns]);
  return (input.paths ?? []).map((raw) => {
    const path = normalize(raw).split(sep).join("/").replace(/\/$/, "");
    if (
      !path ||
      path.startsWith("-") ||
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith("../") ||
      /[\0\n\r]/.test(path) ||
      !isWithin(ctx.projectRoot, resolve(ctx.projectRoot, path))
    )
      throw new Error(`${raw} is not a path inside the project.`);
    if (path !== "." && (excluded.ignores(path) || excluded.ignores(`${path}/`)))
      throw new Error(`${raw} is excluded from worker access.`);
    return path;
  });
}

/** The git argument list for a request, after validating every revision and path. */
export function gitInspectArguments(
  input: GitInspectInput,
  ctx: GitInspectContext,
  filterDrivers: string[] = [],
): string[] {
  if (!GIT_INSPECT_COMMANDS.includes(input.command))
    throw new Error(
      `Unknown command ${input.command}. One of: ${GIT_INSPECT_COMMANDS.join(", ")}.`,
    );
  const revisions = input.revisions ?? [];
  for (const revision of revisions)
    if (!validRevision(revision)) throw new Error(`${revision} is not a revision.`);
  const paths = checkedPaths(input, ctx);
  const limits: Record<GitInspectCommand, [number, number]> = {
    status: [0, 0],
    log: [0, 1],
    show: [0, 1],
    diff: [0, 2],
    file: [1, 1],
  };
  const [least, most] = limits[input.command];
  if (revisions.length < least || revisions.length > most)
    throw new Error(
      `${input.command} takes ${least === most ? least : `${least} to ${most}`} revisions.`,
    );
  // Command-line config outranks the repository's own, so none of its helper
  // programs runs: no fsmonitor, external diff, pager, signature check or filter.
  const settings = [
    ...HELPERS_OFF,
    "diff.external=",
    "core.quotePath=false",
    "protocol.allow=never",
    ...filterDrivers.flatMap((name) =>
      ["clean", "smudge", "process"].map((part) => `filter.${name}.${part}=`),
    ),
  ].flatMap((setting) => ["-c", setting]);
  const patchPaths = [...(paths.length ? paths : ["."]), ...SECRET_PATHSPECS];
  const summary = input.stat ? ["--stat"] : [];
  const noHelpers = ["--no-ext-diff", "--no-textconv"];
  switch (input.command) {
    case "status":
      return [...settings, "status", "--short", "--branch", "--", ...paths];
    case "log": {
      const count = Math.min(Math.max(1, Math.floor(input.maxCount ?? 50)), 500);
      return [
        ...settings,
        "log",
        `--max-count=${count}`,
        "--date=iso-strict",
        "--format=%h %ad %an%n    %s",
        ...summary,
        "--end-of-options",
        ...revisions,
        "--",
        ...paths,
      ];
    }
    case "show":
      return [
        ...settings,
        "show",
        ...noHelpers,
        "--format=commit %H%nAuthor: %an%nDate:   %ad%n%n%w(0,4,4)%B",
        ...summary,
        "--end-of-options",
        revisions[0] ?? "HEAD",
        "--",
        ...patchPaths,
      ];
    case "diff":
      return [
        ...settings,
        "diff",
        ...noHelpers,
        ...summary,
        "--end-of-options",
        ...revisions,
        "--",
        ...patchPaths,
      ];
    case "file": {
      if (paths.length !== 1 || paths[0] === ".")
        throw new Error("file takes exactly one file path.");
      return [
        ...settings,
        "show",
        "--no-textconv",
        "--end-of-options",
        `${revisions[0]}:${paths[0]}`,
      ];
    }
  }
}

let resolvedGit: Promise<{ executable: string; readable: string[] }> | undefined;

/**
 * The git that does the work. On macOS /usr/bin/git only finds the real one
 * through xcrun, which writes a cache the sandbox cannot allow, so resolve it
 * here, outside the sandbox, once.
 */
export function resolveGitBinary(): Promise<{ executable: string; readable: string[] }> {
  resolvedGit ??= (async () => {
    if (process.platform === "darwin") {
      const found = await run("/usr/bin/xcrun", ["--find", "git"], { timeout: 10_000 }).then(
        ({ stdout }) => stdout.trim(),
        () => "",
      );
      // …/Developer/usr/bin/git: the developer directory must stay readable.
      if (found) return { executable: found, readable: [dirname(dirname(dirname(found)))] };
    }
    for (const dir of approvedHostToolDirectories()) {
      const candidate = join(dir, "git");
      if (
        await access(candidate, constants.X_OK).then(
          () => true,
          () => false,
        )
      )
        return { executable: candidate, readable: [] };
    }
    throw new Error("Git is not installed on this machine.");
  })();
  return resolvedGit;
}

export async function runGit(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(executable, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr || failed.message || String(error),
    };
  }
}

function gitEnvironment(git: string, tmp: string, projectRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: [dirname(git), "/usr/bin", "/bin"].join(delimiter),
    HOME: tmp,
    TMPDIR: tmp,
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    // Stop at the project: a repository above it is not this project's.
    GIT_CEILING_DIRECTORIES: dirname(projectRoot),
  };
}

/** A failure the worker should report, not work around. */
function failure(display: string, code: number, stderr: string): string {
  const refused = /Operation not permitted|sandbox/i.test(stderr);
  return [
    `${display} failed (exit ${code}).`,
    stderr.trim().slice(0, 2_000),
    "",
    refused
      ? "The sandbox refused something git needed. This is an environment problem, not a problem with your approach."
      : "If a revision or path is wrong, correct it. Otherwise this is an environment problem, not a problem with your approach.",
    "Do not retry with other programs, shells or cleanup commands. Report this error as it is.",
  ].join("\n");
}

/** One page of the output, with where the next one starts. */
export function page(output: string, offset = 0): string {
  const lines = output.split("\n");
  if (output.endsWith("\n")) lines.pop();
  const start = Math.min(Math.max(0, Math.floor(offset)), lines.length);
  let end = start;
  let size = 0;
  while (end < lines.length && size + lines[end].length + 1 <= PAGE_CHARS) {
    size += lines[end].length + 1;
    end += 1;
  }
  if (end === start && end < lines.length) end += 1;
  const body = lines.slice(start, end).join("\n");
  if (start === 0 && end === lines.length) return body || "(no output)";
  return `${body}\n[lines ${start + 1}–${end} of ${lines.length}.${
    end < lines.length ? ` Next page: offset ${end}, or narrow with paths.` : ""
  }]`;
}

export async function gitInspect(input: GitInspectInput, ctx: GitInspectContext): Promise<string> {
  const git = await resolveGitBinary();
  const exec = ctx.exec ?? runGit;
  const env = gitEnvironment(git.executable, ctx.tmp, ctx.projectRoot);
  const gitDir = join(ctx.projectRoot, ".git");
  const request: SandboxRequest = {
    projectRoot: ctx.projectRoot,
    writable: [],
    tmp: ctx.tmp,
    deniedRead: ctx.deniedRead.filter((path) => !isWithin(gitDir, path)),
    readable: git.readable,
    network: "deny",
  };
  const boundary = await assistCommandBoundary(ctx.qualifySandbox);
  const contain = async (args: string[]) => {
    if (boundary.mode === "sandbox") {
      const wrapped = await wrapWithSandbox(
        [git.executable, ...args],
        request,
        boundary.qualification,
      );
      return exec(wrapped.program, wrapped.arguments, {
        cwd: ctx.projectRoot,
        env,
        signal: ctx.signal,
      });
    }
    return exec(git.executable, args, { cwd: ctx.projectRoot, env, signal: ctx.signal });
  };
  // Validate and show the request before anything runs.
  const requested = gitInspectArguments(input, ctx);
  let first = 0;
  while (requested[first] === "-c") first += 2;
  const display = `git ${requested.slice(first).join(" ")}`;
  if (boundary.mode !== "sandbox") {
    const decision = ctx.authorizeUncontained ? await ctx.authorizeUncontained(display) : "deny";
    if (decision !== "allow")
      return `${display} was not run: no sandbox is available to contain it, and it was not approved.`;
  }
  // Filter drivers are named in the repository's config; each is switched off
  // by name, so read the names first. Reading config runs nothing.
  const listed = await contain(["config", "--local", "--name-only", "--get-regexp", "^filter\\."]);
  const filterDrivers = [
    ...new Set(
      listed.stdout
        .split("\n")
        .map((line) => /^filter\.(.+)\.[^.]+$/.exec(line.trim())?.[1])
        .filter((name): name is string => Boolean(name && /^[A-Za-z0-9_.-]+$/.test(name))),
    ),
  ];
  const args = gitInspectArguments(input, ctx, filterDrivers);
  const result = await contain(args);
  if (result.code !== 0) return failure(display, result.code, result.stderr);
  return page(result.stdout, input.offset);
}
