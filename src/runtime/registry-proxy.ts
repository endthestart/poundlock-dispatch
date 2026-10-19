/**
 * Loopback proxies for sandboxed commands. The registry proxy is the way out
 * for a dependency install (L19); a reach proxy carries a project's other
 * commands when only one of its network switches is on (ADR 015).
 *
 * The registry proxy: the way out for a sandboxed dependency install (L19). The sandbox lets such a
 * command reach only this proxy, on loopback, and the proxy reaches only the
 * read hosts of package registries, matched exactly. Upload hosts such as
 * upload.pypi.org and crates.io's API are not on the list, and neither is
 * GitHub, where a script with a token of its own could push project files.
 *
 * Known limit: npm, RubyGems and NuGet serve downloads and publishes from the
 * same host, which a CONNECT proxy cannot tell apart, so a script holding its
 * own token for one of them could still publish there.
 */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { classifyAddress, type NetworkReach, reachAllows } from "../shared/network.js";

/** Registry read hosts, matched exactly. */
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "index.rubygems.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  "services.gradle.org",
  "api.nuget.org",
  "repo.packagist.org",
] as const;

const PORTS = new Set([80, 443]);
const HEAD_LIMIT = 16 * 1024;

/** A host name of letters, digits, dots and hyphens; anything else is refused before lookup. */
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function registryHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    name.length <= 253 &&
    HOST_NAME.test(name) &&
    (REGISTRY_HOSTS as readonly string[]).includes(name)
  );
}

/** The target of a CONNECT or absolute-URL request head, or why it cannot be read. */
export function proxyTarget(
  head: string,
): { host: string; port: number; connect: boolean } | string {
  const [line = ""] = head.split("\r\n");
  const [method = "", target = ""] = line.split(" ");
  let host: string;
  let port: number;
  if (method.toUpperCase() === "CONNECT") {
    const at = target.lastIndexOf(":");
    if (at < 0) return "CONNECT needs host:port";
    host = target.slice(0, at).replace(/^\[|\]$/g, "");
    port = Number(target.slice(at + 1));
  } else {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return "use CONNECT, or an absolute http:// URL";
    }
    if (url.protocol !== "http:") return "use CONNECT for HTTPS";
    host = url.hostname;
    port = Number(url.port || 80);
  }
  if (!host || !Number.isInteger(port)) return "malformed target";
  return { host, port, connect: method.toUpperCase() === "CONNECT" };
}

/** Where to connect, or why not. */
type Decision = { host: string; port: number } | { refused: string; status?: string };
type Decide = (host: string, port: number) => Promise<Decision>;

function refuse(client: Socket, status: string, reason: string): void {
  const body = `Dispatch dependency proxy: ${reason}\n`;
  client.end(
    `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

/** A started proxy: where it listens, and the credential its commands send. */
export interface RunningProxy {
  port: number;
  credential: string;
}

/**
 * Whether the request head carries this proxy's credential. Every proxy has its
 * own, given only to the commands it serves, so a command cannot borrow another
 * project's way out through loopback (review of ADR 015).
 */
function authorized(head: string, credential: string | undefined): boolean {
  if (!credential) return true;
  const expected =
    `basic ${Buffer.from(`dispatch:${credential}`).toString("base64")}`.toLowerCase();
  return head.split("\r\n").some((line) => {
    const colon = line.indexOf(":");
    return (
      colon > 0 &&
      line.slice(0, colon).trim().toLowerCase() === "proxy-authorization" &&
      line
        .slice(colon + 1)
        .trim()
        .toLowerCase() === expected
    );
  });
}

function handle(client: Socket, decide: Decide, credential?: string): void {
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buffered.length > HEAD_LIMIT) refuse(client, "400 Bad Request", "request head too large");
      return;
    }
    client.off("data", onData);
    const head = buffered.subarray(0, end + 4).toString("latin1");
    const rest = buffered.subarray(end + 4);
    if (!authorized(head, credential))
      return refuse(
        client,
        "407 Proxy Authentication Required",
        "this proxy serves other commands",
      );
    const target = proxyTarget(head);
    if (typeof target === "string") return refuse(client, "403 Forbidden", target);
    // A plain name or IP address only: a NUL or other control byte would
    // otherwise reach the resolver, which throws on it.
    if (
      (!HOST_NAME.test(target.host.toLowerCase()) && isIP(target.host) === 0) ||
      target.host.length > 253
    )
      return refuse(client, "400 Bad Request", "invalid destination host");
    client.pause();
    decide(target.host, target.port).then(
      (decision) => {
        client.resume();
        if ("refused" in decision)
          return refuse(client, decision.status ?? "403 Forbidden", decision.refused);
        open(client, target, decision, head, rest);
      },
      () => refuse(client, "502 Bad Gateway", "the destination could not be resolved"),
    );
  };
  client.on("data", onData);
  client.on("error", () => client.destroy());
}

function open(
  client: Socket,
  target: { host: string; port: number; connect: boolean },
  destination: { host: string; port: number },
  head: string,
  rest: Buffer,
): void {
  let upstream: Socket;
  try {
    upstream = connect(destination.port, destination.host, () => {
      if (target.connect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      else
        upstream.write(
          head
            .replace(/^(\S+) http:\/\/[^/\s]+/, "$1 ")
            .replace(/^proxy-authorization:.*\r\n/gim, ""),
        );
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  } catch {
    return refuse(client, "400 Bad Request", "invalid destination");
  }
  upstream.setTimeout(60_000, () => upstream.destroy());
  upstream.on("error", () => refuse(client, "502 Bad Gateway", "the destination did not answer"));
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
}

/** The registry rule as a decision: an exact registry read host on 80 or 443. */
function registryDecision(permitted: (host: string, port: number) => boolean): Decide {
  return async (host, port) =>
    permitted(host, port)
      ? { host, port }
      : {
          refused: `${host}:${port} is not a package registry on port 80 or 443; dependency installs reach only registries`,
        };
}

/**
 * A project's reach as a decision. Every address the name resolves to must be
 * allowed, and the proxy connects to the address it checked, so a name that
 * re-resolves to a private address between check and connect gains nothing.
 */
export function reachDecision(
  reach: NetworkReach,
  resolve: (host: string) => Promise<string[]> = resolveAll,
): Decide {
  const off = reach.internet
    ? "Local network is off for this project; turn it on in the project's settings to reach this address."
    : "Internet is off for this project; turn it on in the project's settings to reach this address.";
  return async (host, port) => {
    if (port < 1 || port > 65535) return { refused: "malformed target" };
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (!addresses.length)
      return { refused: `${host} does not resolve`, status: "502 Bad Gateway" };
    if (addresses.some((address) => !reachAllows(reach, classifyAddress(address))))
      return { refused: off };
    return { host: addresses[0]!, port };
  };
}

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** A proxy on loopback; `permitted` is a test seam over the registry rule. */
export function startRegistryProxy(
  permitted: (host: string, port: number) => boolean = (host, port) =>
    registryHost(host) && PORTS.has(port),
): Promise<{ server: Server } & RunningProxy> {
  return startProxy(registryDecision(permitted));
}

/** A proxy on loopback that carries a project's commands to what `reach` allows. */
export function startReachProxy(
  reach: NetworkReach,
  resolve?: (host: string) => Promise<string[]>,
): Promise<{ server: Server } & RunningProxy> {
  return startProxy(reachDecision(reach, resolve));
}

function startProxy(decide: Decide): Promise<{ server: Server } & RunningProxy> {
  const credential = randomBytes(18).toString("base64url");
  return new Promise((resolve, reject) => {
    const server = createServer((client) => handle(client, decide, credential));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no proxy port"));
      server.unref();
      resolve({ server, port: address.port, credential });
    });
  });
}

const running = ({ port, credential }: RunningProxy): RunningProxy => ({ port, credential });
let shared: Promise<RunningProxy> | undefined;

/** The process's one registry proxy, started on first use. */
export function registryProxy(): Promise<RunningProxy> {
  shared ??= startRegistryProxy().then(running);
  return shared;
}

const reachProxies = new Map<string, Promise<RunningProxy>>();
const reachPorts = new Map<string, RunningProxy>();
const reachKey = (reach: NetworkReach) => `${reach.internet}/${reach.localNetwork}`;

/** The process's reach proxy for one switch setting, started on first use. */
export function reachProxy(reach: NetworkReach): Promise<RunningProxy> {
  const key = reachKey(reach);
  let proxy = reachProxies.get(key);
  if (!proxy) {
    proxy = startReachProxy(reach).then((started) => {
      reachPorts.set(key, running(started));
      return running(started);
    });
    reachProxies.set(key, proxy);
  }
  return proxy;
}

/** Starts both one-switch reach proxies, for callers that need a port at once. */
export async function startReachProxies(): Promise<void> {
  await Promise.all([
    reachProxy({ internet: true, localNetwork: false }),
    reachProxy({ internet: false, localNetwork: true }),
  ]);
}

/** A started reach proxy, if it is running. */
export function runningReachProxy(reach: NetworkReach): RunningProxy | undefined {
  return reachPorts.get(reachKey(reach));
}

/**
 * What a command needs to use its proxy, credential included. With
 * `loopbackDirect` (Local network on), this Mac's own services are reached
 * directly, as the command's profile then allows.
 */
export function proxyEnvironment(
  { port, credential }: RunningProxy,
  loopbackDirect = false,
): Record<string, string> {
  const url = new URL(`http://127.0.0.1:${port}`);
  url.username = "dispatch";
  url.password = credential;
  const proxy = url.href.replace(/\/$/, "");
  const direct = loopbackDirect ? "localhost,127.0.0.1,::1" : "";
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: direct,
    no_proxy: direct,
  };
}
