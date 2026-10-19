import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkMode } from "./run-command.js";

export interface SandboxQualification {
  available: boolean;
  runtime: "sandbox-exec" | "none";
  reason?: string;
}

export interface SandboxRequest {
  projectRoot: string;
  writable: string[];
  deniedRead: string[];
  /** Exact files a command may read but not change, such as frozen tests. */
  deniedWrite?: string[];
  /** Extra read-only roots, such as an explicitly trusted runtime installation. */
  readable?: string[];
  /**
   * `proxy` is a project with one network switch on (ADR 015): the command
   * reaches this Mac and its reach proxy at `proxyPort`, nothing else.
   */
  network: NetworkMode | "proxy";
  /**
   * In dependency mode, the loopback port of the registry proxy, the only place
   * the command may connect (L19); in proxy mode, the reach proxy's port.
   */
  proxyPort?: number;
  /** In proxy mode, whether this Mac's own services are reachable too (Local network on). */
  loopback?: boolean;
  tmp: string;
  /** The worker's TMPDIR, scratch like `tmp`; a real path, which the sandbox matches on. */
  temp?: string;
}

let cached: SandboxQualification | undefined;

export async function qualifyMacosSandbox(
  execFn: typeof runSandboxExec = runSandboxExec,
): Promise<SandboxQualification> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      runtime: "none",
      reason: "macOS sandbox-exec is not available on this host.",
    };
  }
  if (cached) return cached;
  const probe = await mkdtemp(join(tmpdir(), "dispatch-sandbox-"));
  try {
    const outside = join(probe, "outside.txt");
    await writeFile(outside, "secret");
    const inside = join(probe, "project");
    await mkdir(inside);
    const profile = sandboxProfile({
      projectRoot: inside,
      writable: [inside],
      deniedRead: [outside],
      network: "deny",
      tmp: join(probe, "tmp"),
    });
    await mkdir(join(probe, "tmp"));
    const allowed = await execFn(profile, ["/bin/echo", "ok"], inside);
    if (allowed.code !== 0) {
      cached = {
        available: false,
        runtime: "sandbox-exec",
        reason: "sandbox-exec rejected a permitted project command.",
      };
      return cached;
    }
    const leaked = await execFn(profile, ["/bin/cat", outside], inside);
    if (leaked.code === 0 && leaked.stdout.includes("secret")) {
      cached = {
        available: false,
        runtime: "sandbox-exec",
        reason: "sandbox-exec could not deny reads outside the project.",
      };
      return cached;
    }
    const childLeak = await execFn(profile, ["/bin/sh", "-c", `/bin/cat ${outside}`], inside);
    if (childLeak.code === 0 && childLeak.stdout.includes("secret")) {
      cached = {
        available: false,
        runtime: "sandbox-exec",
        reason: "sandbox-exec did not contain child-process reads.",
      };
      return cached;
    }
    const deniedWrite = join(probe, "outside-write.txt");
    const wroteOutside = await execFn(profile, ["/usr/bin/touch", deniedWrite], inside);
    if (wroteOutside.code === 0) {
      cached = {
        available: false,
        runtime: "sandbox-exec",
        reason: "sandbox-exec allowed a write outside the approved paths.",
      };
      return cached;
    }
    if (requestNeedsNetworkProbe()) {
      const networkFailure = await probeDeniedNetwork(profile, inside, execFn);
      if (networkFailure) {
        cached = { available: false, runtime: "sandbox-exec", reason: networkFailure };
        return cached;
      }
    }
    const cancelled = await execFn(profile, ["/bin/sleep", "30"], inside, 80);
    if (cancelled.code === 0) {
      cached = {
        available: false,
        runtime: "sandbox-exec",
        reason: "sandbox-exec did not honor cancellation.",
      };
      return cached;
    }
    cached = { available: true, runtime: "sandbox-exec" };
    return cached;
  } catch (error) {
    cached = {
      available: false,
      runtime: "none",
      reason: error instanceof Error ? error.message : String(error),
    };
    return cached;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

/**
 * The Mach services a sandboxed command may look up (M10). A blanket
 * `mach-lookup` let it reach services that act outside the sandbox: Launch
 * Services resolved and messaged apps from inside it. These are what account
 * lookup, logging, preferences and TLS verification need; Launch Services, the
 * pasteboard and background URL sessions are not among them.
 */
const MACH_SERVICES = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.notification_center",
  "com.apple.system.logger",
  "com.apple.logd",
  "com.apple.diagnosticd",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.trustd",
  "com.apple.trustd.agent",
  "com.apple.SecurityServer",
  "com.apple.ocspd",
  "com.apple.coreservices.quarantine-resolver",
];

/**
 * The one shared folder a sandboxed command may use. Swift Build (SwiftPM's
 * default build system since Swift 6.3) links in a service that drops TMPDIR
 * and makes /tmp/TemporaryDirectory.*, falling back to /var/tmp when /tmp is
 * refused; with neither, every `swift build` failed at Ld with
 * "permissionDenied". /tmp stays closed because the owner's own builds put
 * their temporary files there; only refused (sandboxed) builds reach /var/tmp.
 */
const SWIFT_BUILD_TEMPORARY =
  '(allow file-read* file-write* (regex #"^/private/var/tmp/TemporaryDirectory\\.[A-Za-z0-9]+(/|$)"))';

export function sandboxProfile(request: SandboxRequest): string {
  const scratch = [request.tmp, ...(request.temp ? [request.temp] : [])];
  const writes = [...request.writable, ...scratch]
    .map((path) => `(allow file-write* (subpath ${literal(path)}))`)
    .join("\n");
  const denyReads = request.deniedRead
    .map((path) => `(deny file-read* (subpath ${literal(path)}))`)
    .join("\n");
  const denyWrites = [
    ...request.deniedRead.map((path) => `(deny file-write* (subpath ${literal(path)}))`),
    ...(request.deniedWrite ?? []).map((path) => `(deny file-write* (literal ${literal(path)}))`),
  ].join("\n");
  const network =
    request.network === "allow"
      ? "(allow network-outbound)"
      : request.network === "dependency" && request.proxyPort
        ? `(allow network-outbound (remote tcp "localhost:${request.proxyPort}"))`
        : request.network === "proxy" && request.proxyPort
          ? request.loopback
            ? '(allow network-outbound (remote ip "localhost:*"))'
            : `(allow network-outbound (remote tcp "localhost:${request.proxyPort}"))`
          : // Either proxy mode without its proxy fails closed.
            "(deny network*)";
  const readable = (request.readable ?? []).map((path) => ` (subpath ${literal(path)})`).join("");
  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal)
(allow sysctl-read)
(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${literal(name)})`).join(" ")})
(allow file-ioctl)
(allow file-read-metadata)
(allow file-write* (literal "/dev/null"))
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt") (subpath "/private/var/db/dyld") (subpath "/System") (subpath "/Library/Developer") (subpath "/dev") (subpath ${literal(request.projectRoot)})${scratch.map((path) => ` (subpath ${literal(path)})`).join("")}${readable})
${writes}
${SWIFT_BUILD_TEMPORARY}
${denyReads}
${denyWrites}
${network}
`;
}

/**
 * A profile that changes only the network, for a command that otherwise runs
 * with the user's authority (Ask, Full access, raw Bash), ADR 015: no network,
 * or the command's proxy (and this Mac's services with Local network on). The
 * Docker socket is closed too, since a container could take the network back,
 * and with no network so are name lookups. Files, other processes and the rest
 * of the account stay as open as the permission mode makes them.
 */
export function networkOnlyProfile(
  network: "deny" | "proxy",
  proxy: { port?: number; loopback?: boolean } = {},
): string {
  const allow =
    network !== "proxy" || !proxy.port
      ? ""
      : proxy.loopback
        ? '(allow network-outbound (remote ip "localhost:*"))'
        : `(allow network-outbound (remote tcp "localhost:${proxy.port}"))`;
  return `(version 1)
(allow default)
(deny network-outbound (remote ip))
(deny network-outbound (remote unix-socket (path-regex #"docker\\.sock$")))
${network === "deny" ? '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))' : ""}
${allow}
`;
}

export async function assistCommandBoundary(
  qualify: typeof qualifyMacosSandbox = qualifyMacosSandbox,
): Promise<{ mode: "sandbox" | "ask"; qualification: SandboxQualification }> {
  const qualification = await qualify();
  return {
    mode: qualification.available ? "sandbox" : "ask",
    qualification,
  };
}

export async function wrapWithSandbox(
  command: string[],
  request: SandboxRequest,
  qualification: SandboxQualification,
): Promise<{ program: string; arguments: string[] }> {
  if (!qualification.available || qualification.runtime !== "sandbox-exec") {
    throw new Error(qualification.reason ?? "The operating-system sandbox is not available.");
  }
  await mkdir(request.tmp, { recursive: true, mode: 0o700 });
  // The profile travels inline, never as a file. Every folder Dispatch could
  // put a file in is one some sandboxed command can write (the private home is
  // its HOME and TMPDIR), and a process left behind by one command could swap
  // the file between Dispatch writing it and sandbox-exec reading it, setting
  // the policy of every later command (H3).
  return {
    program: "/usr/bin/sandbox-exec",
    arguments: ["-p", sandboxProfile(request), ...command],
  };
}

async function runSandboxExec(
  profile: string,
  command: string[],
  cwd: string,
  cancelAfterMs?: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, ...command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const timer =
      cancelAfterMs != null
        ? setTimeout(() => {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* already exited */
            }
          }, cancelAfterMs)
        : undefined;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout });
    });
    // A probe leaves nothing running either.
    child.on("exit", () => killGroup(child.pid));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

/** SIGKILL a process group; a group that is already gone is not an error. */
export function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

function requestNeedsNetworkProbe(): boolean {
  return process.platform === "darwin";
}

async function probeDeniedNetwork(
  profile: string,
  cwd: string,
  execFn: typeof runSandboxExec,
): Promise<string | undefined> {
  const nc = "/usr/bin/nc";
  try {
    await access(nc, constants.X_OK);
  } catch {
    return "The sandbox network probe is unavailable because /usr/bin/nc is missing.";
  }
  const server = createServer((socket) => socket.end());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      return "The sandbox network probe could not reserve a local test port.";
    }
    const networked = await execFn(
      profile,
      [nc, "-z", "-w", "1", "127.0.0.1", String(address.port)],
      cwd,
    );
    return networked.code === 0 ? "sandbox-exec could not deny network." : undefined;
  } catch (error) {
    return `The sandbox network probe could not be completed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

function literal(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export { readFile };
