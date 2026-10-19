import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { dnsProbeScript, hostProbeScript, vmFirewallCommand } from "./vm-firewall";

/**
 * Where an auto run's commands execute (ADR 014). Every command the model
 * writes, every check and every setup step runs here, never on this computer.
 * B1's one backend is a container on the local VM through the Docker CLI
 * (colima on this Mac); it fails closed: no runtime or no image, no run.
 */
export interface IsolationResult {
  exitCode: number | null;
  output: string;
  error?: string;
}

export interface IsolationExecOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?: (chunk: Buffer) => void;
}

/** The container runtime itself is down (the VM stopped): waited out, never a failed check. */
export class IsolationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationUnavailableError";
  }
}

/**
 * Whether a failed call was the Docker client failing, not the command: its
 * first line is the client's own, and the command's output cannot be.
 */
export function isRuntimeFailure(result: IsolationResult): boolean {
  if (result.exitCode === 0) return false;
  if (result.error?.includes("is not installed")) return true;
  const first = result.output.trimStart().split("\n")[0] ?? "";
  return /^(Error response from daemon:|Cannot connect to the Docker daemon|failed to connect to the docker API|error during connect)/i.test(
    first,
  );
}

export interface AutoIsolation {
  /** One line for the owner: where commands run, and with what network. */
  readonly description: string;
  /** The runtime answers and the image is on this machine; returns its ID. Never pulls or builds. */
  check(): Promise<{ imageId: string }>;
  /** The run's container is running: created, or started again after a restart. */
  start(): Promise<void>;
  /**
   * Setup in a throwaway container, with the network only when dependency
   * downloads are approved. A networked setup does not see the mirror, and runs
   * only in a VM whose containers cannot reach this machine (L29).
   */
  prepare(
    command: string,
    options: { network: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<IsolationResult>;
  /** One command in the run's container. A timeout or an abort stops everything running there. */
  exec(command: string, options: IsolationExecOptions): Promise<IsolationResult>;
  /**
   * What the VM behind the runtime shows of `home`, other than the way down to
   * `allowed` (Dispatch's auto folder), as full paths. Empty when the VM does
   * not mount `home` at all. A container escape reaches whatever the VM mounts.
   */
  exposure(home: string, allowed: string): Promise<string[]>;
  /** Kill every process in the run's container except the one keeping it alive. */
  killAll(): Promise<void>;
  remove(): Promise<void>;
}

export interface DockerIsolationOptions {
  /** The docker program; `docker` on the PATH by default. */
  docker?: string;
  /** A docker context, such as `colima-dispatch-auto`; the current one when unset. */
  context?: string;
  image: string;
  /**
   * The image's ID, recorded when the run started. Containers are made from
   * it, so retagging `image` mid-run cannot change what the checks run in.
   */
  imageId?: string;
  /** The run's container, one per run. */
  name: string;
  /** Mounted read-write at the same path: the run's worktree. */
  worktree: string;
  /** Mounted read-only at the same path: the mirror's Git directory. */
  readOnly: string[];
  /** uid:gid commands run as; the owner's, so files keep their owner. */
  user?: string;
  pidsLimit?: number;
  memory?: string;
  cpus?: string;
  /** Environment for the docker program itself (DOCKER_HOST and the like). */
  env?: NodeJS.ProcessEnv;
  /** Names a container might use for this machine (L29); a test seam over `HOST_NAMES`. */
  hostNames?: string[];
  /** The name a networked setup's probe looks up (tests point it at one that fails). */
  dnsName?: string;
}

/** How much of a command's output is kept: its end, where the failure is. */
const OUTPUT_LIMIT = 64_000;
/** Killing what runs in the container must not hang a runner whose VM hangs. */
const KILL_TIMEOUT_MS = 30_000;
/** Run as the container's user, `kill -1` reaches every process of it except PID 1 (the keeper). */
const KILL_ALL = "kill -9 -1 2>/dev/null; true";

function defaultUser(): string {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return `${uid}:${gid}`;
}

/**
 * A label on the run's container naming what it was created with. A container
 * made by an older Dispatch, or by hand, lacks it or differs, and is made again
 * rather than reused with flags nobody checked.
 */
export const SPEC_LABEL = "app.poundlock.dispatch.auto.spec";

/**
 * `docker run` for the run's container or a setup step: no capabilities, no
 * privilege escalation, a process limit, the owner's uid, no network unless
 * asked, and only the worktree writable. Never the home folder, never the
 * Docker socket.
 */
export function dockerRunArgs(options: DockerIsolationOptions, run: RunSpec): string[] {
  return [
    ...runFlags(options, run),
    "--label",
    `${SPEC_LABEL}=${containerSpec(options, run)}`,
    options.imageId ?? options.image,
    ...run.args,
  ];
}

interface RunSpec {
  name: string;
  detach: boolean;
  network: boolean;
  entrypoint: string;
  args: string[];
  /** Leave out the read-only mounts (the mirror): a networked setup needs none of them. */
  withoutReadOnly?: boolean;
}

/** A digest of everything a container is created with. */
export function containerSpec(options: DockerIsolationOptions, run: RunSpec): string {
  return createHash("sha256")
    .update(
      JSON.stringify([...runFlags(options, run), options.imageId ?? options.image, ...run.args]),
    )
    .digest("hex")
    .slice(0, 32);
}

function runFlags(options: DockerIsolationOptions, run: RunSpec): string[] {
  return [
    "run",
    ...(run.detach ? ["-d"] : ["--rm"]),
    // What check() found on this machine, or nothing: never a download (L31).
    "--pull=never",
    "--log-driver=none",
    "--name",
    run.name,
    // The image's own entrypoint would run first; these commands are Dispatch's.
    "--entrypoint",
    run.entrypoint,
    "--label",
    "app.poundlock.dispatch.auto=1",
    "--network",
    run.network ? "bridge" : "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // An init as PID 1 reaps orphans: under `sleep infinity` every process a
    // test leaked and Dispatch killed stayed a zombie, until enough of them
    // filled the container's process limit.
    "--init",
    // No core dumps: a crash during a stop left a 76 MB `core` in the worktree,
    // where it would have joined a case's changes.
    "--ulimit",
    "core=0",
    "--pids-limit",
    String(options.pidsLimit ?? 1024),
    ...(options.memory ? ["--memory", options.memory, "--memory-swap", options.memory] : []),
    ...(options.cpus ? ["--cpus", options.cpus] : []),
    "--user",
    options.user ?? defaultUser(),
    "-e",
    "HOME=/tmp",
    // Bytecode goes under /tmp, which is cleared before the checks: a .pyc a case
    // planted in the worktree or the environment is never loaded (review of L32).
    "-e",
    "PYTHONPYCACHEPREFIX=/tmp/pycache",
    "-v",
    `${options.worktree}:${options.worktree}`,
    // The worktree's `.git` file names its Git directory. Writable, the model
    // could point it at a Git directory of its own, whose configuration host
    // Git would then run in this folder (H4). Mounted after the worktree, so
    // it lies over it.
    "-v",
    `${gitPointer(options.worktree)}:${gitPointer(options.worktree)}:ro`,
    ...(run.withoutReadOnly
      ? []
      : options.readOnly.flatMap((path) => ["-v", `${path}:${path}:ro`])),
    "-w",
    options.worktree,
  ];
}

/** One `key=value` field of a `--mount` option, quoted as CSV when it has to be. */
function mountField(key: string, value: string): string {
  const field = `${key}=${value}`;
  return /[,"]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/**
 * The folders from `home` down to `allowed`, each with the one entry allowed
 * in it. When `allowed` is not inside `home`, nothing in `home` is allowed.
 */
export function mountChain(home: string, allowed: string): Array<{ dir: string; keep?: string }> {
  const rel = relative(home, allowed);
  if (rel === "") return [];
  if (rel.startsWith("..") || isAbsolute(rel)) return [{ dir: home }];
  const chain: Array<{ dir: string; keep?: string }> = [];
  let dir = home;
  for (const part of rel.split(sep)) {
    chain.push({ dir, keep: join(dir, part) });
    dir = join(dir, part);
  }
  return chain;
}

const MOUNTINFO_MARK = "\0MOUNTINFO\n";

/**
 * Lists each folder given as an argument, dotfiles included, NUL-separated,
 * then the container's mount table, so each entry's filesystem is known.
 */
const LIST_FOLDERS = `shopt -s dotglob nullglob; for d in "$@"; do for f in "$d"/*; do printf "%s\\0" "$f"; done; done; printf '\\0MOUNTINFO\\n'; cat /proc/self/mountinfo 2>/dev/null; true`;

/**
 * Filesystems that live on the VM's own disk or memory. Anything else under
 * home (virtiofs, 9p, sshfs and other FUSE, NFS, SMB, a filesystem this list
 * does not know) is treated as reaching the machine running the VM.
 */
const VM_LOCAL_FILESYSTEMS = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "bcachefs",
  "tmpfs",
  "overlay",
  "squashfs",
  "erofs",
  "iso9660",
]);

/** Mount points and filesystem types from /proc/self/mountinfo. */
export function parseMountinfo(text: string): Array<{ point: string; type: string }> {
  const unescape = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  return text.split("\n").flatMap((line) => {
    const fields = line.split(" ");
    const dash = fields.indexOf("-");
    if (dash < 5 || !fields[dash + 1]) return [];
    return [{ point: unescape(fields[4]), type: fields[dash + 1] }];
  });
}

/**
 * Which of `entries` (and which mounts under `home`) reach the machine running
 * the VM. Without a mount table (not Linux), every entry counts. A folder the
 * VM keeps on its own disk is not exposure: it only looks like the owner's.
 */
export function exposedPaths(
  home: string,
  allowed: string,
  entries: string[],
  mounts: Array<{ point: string; type: string }>,
): string[] {
  const chain = mountChain(home, allowed);
  const keep = new Set(chain.map((link) => link.keep).filter(Boolean));
  const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
  const shared = (path: string) => {
    if (!mounts.length) return true;
    let best: { point: string; type: string } | undefined;
    for (const mount of mounts)
      if (within(path, mount.point) && (!best || mount.point.length > best.point.length))
        best = mount;
    return !best || !VM_LOCAL_FILESYSTEMS.has(best.type);
  };
  const exposed = new Set(
    entries.filter((entry) => entry.startsWith(`${home}/`) && !keep.has(entry) && shared(entry)),
  );
  // A share deeper than one level, under a folder the VM keeps on its own disk.
  const onTheWay = (point: string) => within(allowed, point) || within(point, allowed);
  for (const mount of mounts)
    if (
      mount.point.startsWith(`${home}/`) &&
      !onTheWay(mount.point) &&
      !VM_LOCAL_FILESYSTEMS.has(mount.type) &&
      ![...exposed].some((path) => within(mount.point, path))
    )
      exposed.add(mount.point);
  return [...exposed];
}

/** The worktree's `.git` file. */
export function gitPointer(worktree: string): string {
  return join(worktree, ".git");
}

function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

interface Spawned {
  code: number | null;
  output: string;
  error?: string;
}

/** A program's absolute path on this PATH, or the bare name when it is not found. */
function locate(program: string, path: string | undefined): string {
  if (program.includes("/")) return program;
  for (const dir of (path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, program);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return program;
}

export function dockerIsolation(given: DockerIsolationOptions): AutoIsolation {
  // Its own copy: check() fills in the default memory limit.
  const options = { ...given };
  // Fixed now: a worker attempt narrows the process PATH for Pi's own tools,
  // and that must never change which docker runs or what it connects to.
  const env = { ...(options.env ?? process.env) };
  const docker = locate(options.docker ?? "docker", env.PATH);
  const global = options.context ? ["--context", options.context] : [];
  const where = options.context ? ` (context ${options.context})` : "";

  const call = (
    args: string[],
    extra: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onData?: (chunk: Buffer) => void;
      onStop?: () => Promise<void>;
    } = {},
  ): Promise<Spawned> =>
    new Promise((resolve) => {
      let output = "";
      let error: string | undefined;
      let settled = false;
      const child = spawn(docker, [...global, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stop = (reason: string) => {
        if (error) return;
        error = reason;
        // Killing the docker client leaves the command running in the container.
        void (extra.onStop?.() ?? Promise.resolve()).finally(() => child.kill("SIGKILL"));
      };
      const onAbort = () => stop("Cancelled");
      extra.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = extra.timeoutMs
        ? setTimeout(
            () => stop(`Command timed out after ${duration(extra.timeoutMs ?? 0)}`),
            extra.timeoutMs,
          )
        : undefined;
      const collect = (chunk: Buffer) => {
        extra.onData?.(chunk);
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        extra.signal?.removeEventListener("abort", onAbort);
        resolve({ code: error ? null : code, output, ...(error ? { error } : {}) });
      };
      child.on("error", (caught: NodeJS.ErrnoException) => {
        error =
          caught.code === "ENOENT"
            ? `The container runtime (${docker}) is not installed or not on the PATH.`
            : caught.message;
        finish(null);
      });
      child.on("close", finish);
      if (extra.signal?.aborted) onAbort();
    });

  // Leave the VM room to run Docker itself when a command runs away: without a
  // limit of its own, a container gets three quarters of the VM's memory. Read
  // once, before anything is created, so every container gets the same flags.
  let memoryRead = false;
  const memoryLimit = async () => {
    if (memoryRead || options.memory) return;
    memoryRead = true;
    const info = await call(["info", "--format", "{{.MemTotal}}"]);
    const total = Number(info.output.trim());
    if (info.code === 0 && Number.isFinite(total) && total > 0)
      options.memory = `${Math.floor((total * 0.75) / 1024 ** 2)}m`;
  };

  const killAll = async () => {
    await call(["exec", options.name, "sh", "-c", KILL_ALL], { timeoutMs: KILL_TIMEOUT_MS });
  };
  const setup = `${options.name}-setup`;
  /**
   * A container on the VM's bridge must not reach this machine (L29): listen on
   * loopback here and try every name a container might use for it.
   */
  const assertHostUnreachable = async () => {
    const listener = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const probe = await call(
        [
          "run",
          "--rm",
          "--pull=never",
          "--label",
          "app.poundlock.dispatch.auto=1",
          "--network",
          "bridge",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          options.user ?? defaultUser(),
          "--entrypoint",
          "bash",
          options.imageId ?? options.image,
          "-c",
          `${hostProbeScript(port, options.hostNames)}; ${dnsProbeScript(options.dnsName)}`,
        ],
        { timeoutMs: KILL_TIMEOUT_MS },
      );
      const reached = probe.output.match(/REACHED:\S+/g);
      if (reached)
        throw new Error(
          `A container in this VM can reach this Mac (${reached.join(", ").replaceAll("REACHED:", "")}), so setup with the network would expose its services. Apply Dispatch's VM firewall, then retry: ${vmFirewallCommand()}`,
        );
      // Otherwise every download times out, which reads as a broken project.
      if (/\bUNRESOLVED\b/.test(probe.output))
        throw new Error(
          `Containers in this VM cannot look up names, so setup cannot download dependencies. Apply Dispatch's VM network rules, which point the VM at public DNS servers, then retry: ${vmFirewallCommand()}`,
        );
    } finally {
      listener.close();
    }
  };
  const removeSetup = async () => {
    await call(["rm", "-f", setup], { timeoutMs: KILL_TIMEOUT_MS });
  };

  return {
    description: `a container (${options.image}), no network${where}`,

    async check() {
      const version = await call(["version", "--format", "{{.Server.Version}}"]);
      if (version.code !== 0)
        throw new Error(
          version.error?.includes("not installed")
            ? version.error
            : `The container runtime is not answering${where}. Start its VM (auto mode's own: colima start --profile dispatch-auto), then try again.`,
        );
      const image = await call([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        options.imageId ?? options.image,
      ]);
      if (image.code !== 0)
        throw new Error(
          options.imageId
            ? `The image this run started with (${options.image}, ${options.imageId}) is not on this machine any more. Start a new run.`
            : `The image ${options.image} is not on this machine. Build or pull it yourself; Dispatch never downloads it.`,
        );
      await memoryLimit();
      return { imageId: image.output.trim() };
    },

    async start() {
      await memoryLimit();
      const keeper: RunSpec = {
        name: options.name,
        detach: true,
        network: false,
        entrypoint: "sleep",
        args: ["infinity"],
      };
      const spec = containerSpec(options, keeper);
      const state = await call([
        "inspect",
        "--format",
        `{{.State.Running}} ${SPEC_LABEL}={{index .Config.Labels "${SPEC_LABEL}"}}`,
        options.name,
      ]);
      const [running, label] = state.output.trim().split(" ");
      const labelled = label === `${SPEC_LABEL}=${spec}`;
      let exists = state.code === 0;
      if (exists && !labelled) {
        // Made with other flags (an older Dispatch, say): nothing in it is kept
        // but its processes, so make it again rather than trust it.
        await call(["rm", "-f", options.name], { timeoutMs: KILL_TIMEOUT_MS });
        exists = false;
      }
      if (exists && running !== "true") {
        const started = await call(["start", options.name]);
        if (started.code !== 0)
          throw new Error(`The run's container did not start: ${started.output.trim()}`);
      } else if (!exists) {
        const created = await call(dockerRunArgs(options, keeper));
        if (created.code !== 0)
          throw new Error(
            `The run's container could not be created: ${(created.error ?? created.output).trim()}`,
          );
      }
      const shell = await call(["exec", options.name, "bash", "-c", "true"]);
      if (shell.code !== 0)
        throw new Error(`The image ${options.image} has no bash, which auto mode's commands need.`);
    },

    async prepare(command, prepare) {
      // Named, so a timeout, a stop or a resume after a crash can remove it: killing
      // the client alone would leave an install running with the network.
      await memoryLimit();
      await removeSetup();
      if (prepare.network) await assertHostUnreachable();
      const result = await call(
        dockerRunArgs(options, {
          name: setup,
          detach: false,
          network: prepare.network,
          entrypoint: "bash",
          args: ["-c", command],
          withoutReadOnly: prepare.network,
        }),
        { signal: prepare.signal, timeoutMs: prepare.timeoutMs, onStop: removeSetup },
      );
      return { exitCode: result.code, output: result.output, error: result.error };
    },

    async exec(command, exec) {
      const result = await call(
        ["exec", "-w", exec.cwd, "-e", "HOME=/tmp", options.name, "bash", "-c", command],
        {
          signal: exec.signal,
          timeoutMs: exec.timeoutMs,
          onData: exec.onData,
          onStop: killAll,
        },
      );
      return { exitCode: result.code, output: result.output, error: result.error };
    },

    async exposure(home, allowed) {
      const chain = mountChain(home, allowed);
      if (!chain.length) return [];
      const probe = await call(
        [
          "run",
          "--rm",
          "--pull=never",
          "--label",
          "app.poundlock.dispatch.auto=1",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          options.user ?? defaultUser(),
          "--mount",
          ["type=bind", mountField("source", home), mountField("target", home), "readonly"].join(
            ",",
          ),
          "--entrypoint",
          "bash",
          options.image,
          "-c",
          LIST_FOLDERS,
          "probe",
          ...chain.map((link) => link.dir),
        ],
        { timeoutMs: KILL_TIMEOUT_MS },
      );
      if (probe.code !== 0) {
        // The VM has no such folder: it mounts nothing of home.
        if (/bind source path does not exist/i.test(probe.output)) return [];
        throw new Error(
          `Could not check what the container VM mounts${where}: ${(probe.error ?? probe.output).trim()}`,
        );
      }
      const [listing, mountinfo = ""] = probe.output.split(MOUNTINFO_MARK);
      return exposedPaths(
        home,
        allowed,
        listing.split("\0").filter(Boolean),
        parseMountinfo(mountinfo),
      );
    },

    killAll,

    async remove() {
      await removeSetup();
      await call(["rm", "-f", options.name], { timeoutMs: KILL_TIMEOUT_MS });
    },
  };
}
