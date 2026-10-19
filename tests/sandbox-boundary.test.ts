/**
 * H3: the sandbox profile is never a file a sandboxed command can reach, and
 * nothing a command starts outlives it.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { descendants, executeResolvedCommand, resolveCommand } from "@runtime/run-command";
import {
  qualifyMacosSandbox,
  type SandboxRequest,
  sandboxProfile,
  wrapWithSandbox,
} from "@runtime/sandbox";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((done) => setTimeout(done, 25));
  return check();
}

async function shell(script: string, home: string) {
  const resolved = await resolveCommand(
    { program: "/bin/sh", arguments: ["-c", script], capability: "inspect", effect: "inspect" },
    home,
    [],
    home,
  );
  return executeResolvedCommand(resolved, new AbortController().signal);
}

async function layout() {
  const root = await tempDir("dispatch-h3-");
  const project = join(root, "project");
  const home = join(root, "home");
  const secret = join(root, "secret.txt");
  await mkdir(project);
  await mkdir(home);
  await writeFile(secret, "top-secret");
  const request: SandboxRequest = {
    projectRoot: project,
    writable: [project],
    deniedRead: [secret],
    network: "deny",
    tmp: home,
  };
  return { project, home, secret, request };
}

describe("sandbox profile delivery", () => {
  it("passes the profile inline and leaves no profile file in a writable folder", async () => {
    const { home, request } = await layout();
    const wrapped = await wrapWithSandbox(["/bin/echo", "ok"], request, {
      available: true,
      runtime: "sandbox-exec",
    });
    expect(wrapped.program).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.arguments[0]).toBe("-p");
    expect(wrapped.arguments[1]).toBe(sandboxProfile(request));
    expect(wrapped.arguments.slice(2)).toEqual(["/bin/echo", "ok"]);
    expect(await readdir(home)).toEqual([]);
  });
});

describe("leftover processes", () => {
  it("finds every process below a command through parent links", () => {
    expect(
      descendants(10, [
        [11, 10],
        [12, 11],
        [13, 1],
        [14, 12],
      ]).sort(),
    ).toEqual([11, 12, 14]);
  });

  // Not /bin/sleep: ps cannot read a protected system binary's environment.
  it("ends a long command's child that moved to its own group and outlived it", async () => {
    const home = await tempDir("dispatch-orphan-");
    const pidFile = join(home, "orphan.pid");
    const resolved = await resolveCommand(
      {
        program: process.execPath,
        arguments: [
          "-e",
          `const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore"});c.unref();require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>process.exit(0),2300);`,
        ],
        capability: "inspect",
        effect: "inspect",
      },
      home,
      [],
      home,
    );
    expect(resolved.env?.DISPATCH_RUN).toMatch(/^[0-9a-f]{16}$/);
    const result = await executeResolvedCommand(resolved, new AbortController().signal);
    expect(result.exitCode).toBe(0);
    const orphan = Number(await readFile(pidFile, "utf8"));
    expect(await until(() => !alive(orphan))).toBe(true);
  });

  it("ends a timed-out command's child that moved to its own process group", async () => {
    const home = await tempDir("dispatch-escaped-");
    const pidFile = join(home, "escaped.pid");
    const resolved = await resolveCommand(
      {
        program: process.execPath,
        arguments: [
          "-e",
          `const c=require("child_process").spawn("/bin/sleep",["30"],{detached:true,stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`,
        ],
        capability: "inspect",
        effect: "inspect",
      },
      home,
      [],
      home,
    );
    const result = await executeResolvedCommand(
      { ...resolved, timeoutMs: 1500 },
      new AbortController().signal,
    );
    expect(result.error).toBe("Command timed out");
    const escaped = Number(await readFile(pidFile, "utf8"));
    expect(await until(() => !alive(escaped))).toBe(true);
  });

  it("kills a background process a command leaves behind", async () => {
    const home = await tempDir("dispatch-leftover-");
    const result = await shell("sleep 30 >/dev/null 2>&1 & echo $!", home);
    expect(result.exitCode).toBe(0);
    const pid = Number(result.output.trim());
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("returns when the command exits, even if a leftover holds its output open", async () => {
    const home = await tempDir("dispatch-leftover-pipe-");
    const started = Date.now();
    const result = await shell("sleep 30 & echo $!", home);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).toBe(0);
    const pid = Number(result.output.trim());
    expect(await until(() => !alive(pid))).toBe(true);
  });
});

const sandboxed = process.platform === "darwin" && (await qualifyMacosSandbox()).available;

describe.skipIf(!sandboxed)("sandbox profile integrity (macOS)", () => {
  async function run(request: SandboxRequest, command: string[], cwd: string) {
    const wrapped = await wrapWithSandbox(command, request, {
      available: true,
      runtime: "sandbox-exec",
    });
    const resolved = await resolveCommand(
      { program: "/bin/echo", arguments: [], capability: "inspect", effect: "inspect" },
      cwd,
      [],
      request.tmp,
    );
    return executeResolvedCommand(
      { ...resolved, executable: wrapped.program, arguments: wrapped.arguments },
      new AbortController().signal,
    );
  }

  it("a sandboxed command cannot reach Launch Services, so it cannot open or message apps (M10)", async () => {
    const { project, request } = await layout();
    // Resolving an app's path is read-only. With Launch Services reachable it
    // answers, and opening or messaging the app is the next call.
    const resolve = [
      "/usr/bin/osascript",
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("com.apple.TextEdit"); u.isNil() ? "none" : u.path.js',
    ];
    const sandboxed = await run(request, resolve, project);
    expect(sandboxed.output).not.toContain("TextEdit.app");
  });

  it("a dependency install reaches only the registry proxy port (L19)", async () => {
    const { project, request } = await layout();
    const listen = async () => {
      const server = createServer((socket) => socket.end());
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      return { server, port: (server.address() as { port: number }).port };
    };
    const proxy = await listen();
    const other = await listen();
    try {
      const dependency = { ...request, network: "dependency" as const, proxyPort: proxy.port };
      const reach = (port: number) =>
        run(dependency, ["/usr/bin/nc", "-z", "-w", "2", "127.0.0.1", String(port)], project);
      expect((await reach(proxy.port)).exitCode).toBe(0);
      expect((await reach(other.port)).exitCode).not.toBe(0);
    } finally {
      proxy.server.close();
      other.server.close();
    }
  });

  it("a sandboxed command cannot change the profile of the next one", async () => {
    const { project, home, secret, request } = await layout();
    const permissive = "(version 1)\n(allow default)\n";
    // The first command can write where the old profile file lived, and tries
    // to keep rewriting it after it ends.
    const first = await run(
      request,
      [
        "/bin/sh",
        "-c",
        `printf '${permissive}' > ${home}/dispatch.sb; (while :; do printf '${permissive}' > ${home}/dispatch.sb; sleep 0.01; done) >/dev/null 2>&1 & echo $!`,
      ],
      project,
    );
    expect(first.exitCode).toBe(0);
    const leftover = Number(first.output.trim());
    expect(await until(() => !alive(leftover))).toBe(true);
    // Even a writer racing from outside cannot reach the next command's policy.
    let racing = true;
    const race = (async () => {
      while (racing) {
        await writeFile(join(home, "dispatch.sb"), permissive).catch(() => undefined);
        await new Promise((done) => setTimeout(done, 1));
      }
    })();
    try {
      const second = await run(request, ["/bin/cat", secret], project);
      expect(second.exitCode).not.toBe(0);
      expect(second.output).not.toContain("top-secret");
    } finally {
      racing = false;
      await race;
    }
  });
});
