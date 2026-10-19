/**
 * A project's Internet and Local network switches (ADR 015): what each command
 * may reach, whatever the permission mode, and the proxy that carries it when
 * only one switch is on.
 */

import { connect, createServer } from "node:net";
import { join } from "node:path";
import { commandNetwork, networkBashHook } from "@runtime/command-network";
import { type HostCommandContext, runHostCommand } from "@runtime/host-command";
import { startReachProxies, startReachProxy } from "@runtime/registry-proxy";
import type { RunCommandInput } from "@runtime/run-command";
import { buildSandboxRequest } from "@runtime/sandbox-policy";
import {
  classifyAddress,
  describeReach,
  type NetworkReach,
  projectReach,
  reachAllows,
} from "@shared/network";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const BOTH = { internet: true, localNetwork: true };
const INTERNET = { internet: true, localNetwork: false };
const LOCAL = { internet: false, localNetwork: true };
const NONE = { internet: false, localNetwork: false };

describe("the switches", () => {
  it("default to internet on and local network off", () => {
    expect(projectReach()).toEqual(INTERNET);
    expect(projectReach({ network: { localNetwork: true } })).toEqual(BOTH);
    expect(projectReach({ network: { internet: false } })).toEqual(NONE);
    expect(describeReach(LOCAL)).toBe("Local network only");
  });

  it("sort addresses into public, private, this Mac and refused", () => {
    for (const address of ["93.184.215.14", "8.8.8.8", "2606:4700::6810:84e5"])
      expect(classifyAddress(address), address).toBe("public");
    for (const address of [
      "10.20.0.72",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "100.127.255.1",
      "fd12::1",
      "fe80::1",
      "::ffff:192.168.1.1",
    ])
      expect(classifyAddress(address), address).toBe("private");
    for (const address of ["127.0.0.1", "127.8.8.8", "::1", "::ffff:127.0.0.1"])
      expect(classifyAddress(address), address).toBe("loopback");
    for (const address of [
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "ff02::1",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
    ])
      expect(classifyAddress(address), address).toBe("refused");
    expect(classifyAddress("172.32.0.1")).toBe("public");
    expect(classifyAddress("100.128.0.1")).toBe("public");
  });

  it("count this Mac's own services as the local network", () => {
    expect(reachAllows(INTERNET, "loopback")).toBe(false);
    expect(reachAllows(LOCAL, "loopback")).toBe(true);
    expect(reachAllows(NONE, "loopback")).toBe(false);
    expect(reachAllows(INTERNET, "private")).toBe(false);
    expect(reachAllows(LOCAL, "public")).toBe(false);
    expect(reachAllows(BOTH, "refused")).toBe(false);
  });

  it("read every textual form of an address the same way", () => {
    for (const address of ["::ffff:c0a8:101", "0:0:0:0:0:ffff:c0a8:101", "::c0a8:101", "fec0::1"])
      expect(classifyAddress(address), address).toBe("private");
    expect(classifyAddress("[::1]")).toBe("loopback");
    expect(classifyAddress("::127.0.0.1")).toBe("loopback");
    expect(classifyAddress("fe80::1%en0")).toBe("private");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
    for (const address of ["1::2::3", "1.2.3", "300.1.1.1", "gggg::1"])
      expect(classifyAddress(address), address).toBe("refused");
  });
});

describe("a command's network", () => {
  it("follows the switches unless the command asks for none", () => {
    expect(commandNetwork("allow", BOTH)).toEqual({ kind: "direct" });
    expect(commandNetwork("allow", INTERNET)).toEqual({ kind: "reach" });
    expect(commandNetwork("allow", LOCAL)).toEqual({ kind: "reach" });
    expect(commandNetwork("allow", NONE)).toEqual({ kind: "none" });
    expect(commandNetwork("deny", BOTH)).toEqual({ kind: "none" });
  });

  it("sends installs to the registry proxy only while Internet is on", () => {
    expect(commandNetwork("dependency", INTERNET)).toEqual({ kind: "registry" });
    expect(commandNetwork("dependency", BOTH)).toEqual({ kind: "registry" });
    expect(commandNetwork("dependency", LOCAL)).toMatchObject({
      refused: expect.stringContaining("Internet is off"),
    });
  });

  it("is none in an investigation", () => {
    expect(commandNetwork("allow", BOTH, true)).toEqual({ kind: "none" });
    expect(commandNetwork("dependency", BOTH, true)).toHaveProperty("refused");
  });
});

function project(root: string, reach: NetworkReach): ProjectRecord {
  return {
    id: "project",
    name: "Example",
    status: "draft",
    source: { kind: "local_folder", originalPath: root, excludedPatterns: [] },
    policy: { ...defaultPolicy(), network: reach },
    budget: defaultBudget(),
  } as unknown as ProjectRecord;
}

async function context(
  trust: HostCommandContext["trust"],
  reach: NetworkReach,
): Promise<HostCommandContext & { ran: { argv: string[]; env: NodeJS.ProcessEnv }[] }> {
  const root = await tempDir("network-");
  const home = join(root, "..", `${root.split("/").pop()}-home`);
  const sandboxRequest = await buildSandboxRequest({
    projectRoot: root,
    project: project(root, reach),
    privateHome: home,
    network: "deny",
  });
  const ran: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
  return {
    ran,
    projectRoot: root,
    extraPath: [],
    privateHome: home,
    trust,
    allowDependencyNetwork: false,
    reach,
    sandboxRequest,
    signal: new AbortController().signal,
    qualifySandbox: async () => ({ available: true, runtime: "sandbox-exec" }),
    authorize: async () => "allow",
    execute: async (command) => {
      ran.push({ argv: [command.executable, ...command.arguments], env: command.env });
      return { exitCode: 0, output: "ok" };
    },
  };
}

const ls: RunCommandInput = {
  program: "ls",
  arguments: ["-la"],
  capability: "inspect",
  effect: "inspect",
};

describe("enforcement", () => {
  it("puts the switches in the sandbox profile in Assist", async () => {
    const cases: [NetworkReach, RegExp, boolean][] = [
      [BOTH, /\(allow network-outbound\)/, false],
      // Internet only: the command's own proxy port and nothing else on this Mac.
      [INTERNET, /\(allow network-outbound \(remote tcp "localhost:\d+"\)\)/, true],
      [LOCAL, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/, true],
      [NONE, /\(deny network\*\)/, false],
    ];
    for (const [reach, rule, proxied] of cases) {
      const ctx = await context("assist", reach);
      await runHostCommand(ls, ctx);
      const [{ argv, env }] = ctx.ran;
      expect(argv.slice(0, 2), describeReach(reach)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
      expect(argv[2], describeReach(reach)).toMatch(rule);
      expect(Boolean(env.HTTPS_PROXY), describeReach(reach)).toBe(proxied);
      if (proxied) expect(env.HTTPS_PROXY).toMatch(/^http:\/\/dispatch:[\w-]+@127\.0\.0\.1:\d+$/);
      if (proxied) expect(env.NO_PROXY).toBe(reach.localNetwork ? "localhost,127.0.0.1,::1" : "");
    }
  });

  it("wraps an unsandboxed command in a network-only profile unless both switches are on", async () => {
    for (const trust of ["ask", "full"] as const) {
      const open = await context(trust, BOTH);
      await runHostCommand(ls, open);
      expect(open.ran[0]!.argv[0]).not.toBe("/usr/bin/sandbox-exec");

      const internet = await context(trust, INTERNET);
      await runHostCommand(ls, internet);
      const [program, flag, profile] = internet.ran[0]!.argv;
      expect([program, flag]).toEqual(["/usr/bin/sandbox-exec", "-p"]);
      expect(profile).toContain("(allow default)");
      expect(profile).toContain("(deny network-outbound (remote ip))");
      expect(profile).toMatch(/\(remote tcp "localhost:\d+"\)/);
      expect(profile).toContain("docker\\.sock");

      const none = await context(trust, NONE);
      await runHostCommand(ls, none);
      expect(none.ran[0]!.argv[2]).not.toContain("localhost");
      expect(none.ran[0]!.argv[2]).toContain("mDNSResponder");
    }
  });

  it("refuses an install while Internet is off, and needs no plan for one while it is on", async () => {
    const install: RunCommandInput = {
      program: "npm",
      arguments: ["ci"],
      capability: "install_deps",
      effect: "project_change",
    };
    await expect(runHostCommand(install, await context("assist", LOCAL))).rejects.toThrow(
      /Internet is off/,
    );
    const ctx = await context("assist", INTERNET);
    await runHostCommand(install, ctx);
    expect(ctx.ran[0]!.argv[2]).toMatch(/\(remote tcp "localhost:\d+"\)/);
  });

  it("no longer reserves the project's network for Full access", async () => {
    const ctx = await context("assist", INTERNET);
    await runHostCommand({ ...ls, networkMode: "allow" }, ctx);
    expect(ctx.ran).toHaveLength(1);
  });
});

/** With the proxy's credential unless `bare`, as a command given its environment sends it. */
function signed(proxy: { credential: string }, request: string): string {
  const auth = Buffer.from(`dispatch:${proxy.credential}`).toString("base64");
  return request.replace(/\r\n\r\n$/, `\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
}

function exchange(proxy: { port: number; credential: string }, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write(signed(proxy, request)));
    let answer = "";
    socket.on("data", (chunk) => {
      answer += chunk.toString();
    });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(answer);
    }, 500);
  });
}

describe("the reach proxy", () => {
  const resolver = (table: Record<string, string[]>) => async (host: string) => table[host] ?? [];

  it("refuses the local network with Internet only, and the internet with Local network only", async () => {
    const names = resolver({ "router.home": ["192.168.1.1"], "example.com": ["93.184.215.14"] });
    const internet = await startReachProxy(INTERNET, names);
    const local = await startReachProxy(LOCAL, names);
    try {
      for (const target of ["router.home:443", "10.20.0.72:8123"]) {
        const answer = await exchange(internet, `CONNECT ${target} HTTP/1.1\r\n\r\n`);
        expect(answer, target).toMatch(/^HTTP\/1.1 403/);
        expect(answer).toContain("Local network is off");
      }
      const answer = await exchange(local, "CONNECT example.com:443 HTTP/1.1\r\n\r\n");
      expect(answer).toMatch(/^HTTP\/1.1 403/);
      expect(answer).toContain("Internet is off");
    } finally {
      internet.server.close();
      local.server.close();
    }
  });

  it("serves only commands that carry its own credential", async () => {
    const names = resolver({ "router.home": ["192.168.1.1"] });
    const local = await startReachProxy(LOCAL, names);
    const internet = await startReachProxy(INTERNET, names);
    try {
      // An Internet-only command that finds the Local-only proxy on loopback.
      const borrowed = await exchange(
        { port: local.port, credential: internet.credential },
        "CONNECT router.home:443 HTTP/1.1\r\n\r\n",
      );
      expect(borrowed).toMatch(/^HTTP\/1.1 407/);
      const bare = await new Promise<string>((resolve) => {
        const socket = connect(local.port, "127.0.0.1", () =>
          socket.write("CONNECT router.home:443 HTTP/1.1\r\n\r\n"),
        );
        let answer = "";
        socket.on("data", (chunk) => {
          answer += chunk;
        });
        socket.on("close", () => resolve(answer));
      });
      expect(bare).toMatch(/^HTTP\/1.1 407/);
    } finally {
      local.server.close();
      internet.server.close();
    }
  });

  it("refuses a name that resolves to any address it may not reach", async () => {
    const proxy = await startReachProxy(
      INTERNET,
      resolver({ "rebind.example": ["93.184.215.14", "10.20.0.1"] }),
    );
    try {
      const answer = await exchange(proxy, "CONNECT rebind.example:443 HTTP/1.1\r\n\r\n");
      expect(answer).toMatch(/^HTTP\/1.1 403/);
    } finally {
      proxy.server.close();
    }
  });

  it("tunnels to an allowed destination at the address it checked", async () => {
    const upstream = createServer((socket) => socket.end("hello from upstream"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const proxy = await startReachProxy(LOCAL, resolver({ "box.home": ["127.0.0.1"] }));
    try {
      const answer = await exchange(proxy, `CONNECT box.home:${address.port} HTTP/1.1\r\n\r\n`);
      expect(answer).toContain("200 Connection Established");
      expect(answer).toContain("hello from upstream");
    } finally {
      proxy.server.close();
      upstream.close();
    }
  });
});

describe("raw Bash", () => {
  const spawn = { command: "curl https://example.com", cwd: "/tmp", env: { PATH: "/usr/bin" } };

  it("runs inside a network-only sandbox unless both switches are on", async () => {
    await startReachProxies();
    const internetOnly = networkBashHook(() => INTERNET, true)(spawn);
    expect(internetOnly.command).toContain("/usr/bin/sandbox-exec");
    expect(internetOnly.env.DISPATCH_COMMAND).toBe(spawn.command);
    expect(internetOnly.env.DISPATCH_NETWORK_PROFILE).toMatch(/\(remote tcp "localhost:\d+"\)/);
    expect(internetOnly.env.HTTPS_PROXY).toMatch(/^http:\/\/dispatch:[\w-]+@127\.0\.0\.1:\d+$/);
    const localOnly = networkBashHook(() => LOCAL, true)(spawn);
    expect(localOnly.env.DISPATCH_NETWORK_PROFILE).toContain('(remote ip "localhost:*")');

    const none = networkBashHook(() => NONE, true)(spawn);
    expect(none.env.DISPATCH_NETWORK_PROFILE).not.toContain("localhost");
    expect(none.env.HTTPS_PROXY).toBeUndefined();

    expect(networkBashHook(() => BOTH, true)(spawn)).toBe(spawn);
    expect(networkBashHook(() => NONE, false)(spawn)).toBe(spawn);
  });
});

const sandboxed =
  process.platform === "darwin" &&
  (await import("@runtime/sandbox").then((s) => s.qualifyMacosSandbox())).available;

describe.skipIf(!sandboxed)("the switches under sandbox-exec (macOS)", () => {
  async function run(command: string, env: NodeJS.ProcessEnv): Promise<string> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", command], { env });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("close", () => resolve(out.trim()));
    });
  }

  it("lets raw Bash reach this Mac only with Local network on", async () => {
    const upstream = createServer((socket) =>
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"),
    );
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    await startReachProxies();
    const curl = `/usr/bin/curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${address.port}/`;
    const base = { command: curl, cwd: "/tmp", env: { PATH: "/usr/bin:/bin" } };
    try {
      const local = networkBashHook(() => LOCAL, true)(base);
      expect(await run(local.command, local.env)).toBe("200");
      // Through its proxy, which refuses this Mac's own services.
      const internet = networkBashHook(() => INTERNET, true)(base);
      expect(await run(internet.command, internet.env)).toBe("403");
      const none = networkBashHook(() => NONE, true)(base);
      expect(await run(none.command, none.env)).toBe("000");
    } finally {
      upstream.close();
    }
  });
});
