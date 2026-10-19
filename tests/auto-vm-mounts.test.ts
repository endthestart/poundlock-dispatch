/**
 * M11: auto mode refuses a container VM that can see the owner's home folder
 * beyond Dispatch's auto folder, unless the owner explicitly overrides it.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dockerIsolation, exposedPaths, mountChain, parseMountinfo } from "@core/auto/isolation";
import { AutoLedger } from "@core/auto/ledger";
import {
  AUTO_DOCKER_CONTEXT,
  AutoPaths,
  dedicatedVmCommand,
  projectKey,
  readRunFile,
  releaseProjectLock,
} from "@core/auto/runs";
import { startAutoRun } from "@core/auto/start";
import { runAuto } from "@tui/auto";
import { afterAll, describe, expect, it } from "vitest";
import { fakeDocker } from "./support/fake-docker";
import { fakePoundlock } from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

/** A home folder as a VM would show it, with Dispatch's data root inside. */
async function fakeHome(extra: string[] = []) {
  const home = await realpath(await tempDir("auto-vm-home-"));
  const data = join(home, ".poundlock-dispatch");
  await mkdir(join(data, "auto"), { recursive: true });
  for (const path of extra) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(join(home, path), "private");
  }
  return { home, paths: new AutoPaths(data) };
}

async function setup(extra: string[] = []) {
  const { home, paths } = await fakeHome(extra);
  const source = await realpath(await tempDir("auto-vm-src-"));
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "README.md"), "base\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const server = await fakePoundlock({ respond: () => ({ text: "unused" }) });
  servers.push(server);
  const docker = await fakeDocker(["toolchain:test"]);
  const deps = {
    paths,
    connection: async () => ({ url: server.url, token: server.token, roles: {}, profiles: {} }),
    project: async () => undefined,
    spawnRunner: () => undefined,
    docker: docker.docker,
    dockerEnv: docker.env,
    freeBytes: async () => 100 * 1024 ** 3,
    home,
  };
  const request = {
    dir: source,
    plan: {
      cases: [{ id: "C1", title: "one", objective: "o", acceptanceCriteria: "a", dependsOn: [] }],
      checks: ["true"],
    },
    profile: "gate-model",
    image: "toolchain:test",
  };
  return { home, paths, source, docker, deps, request };
}

describe("the way down to the auto folder", () => {
  it("allows only the next folder at each level", () => {
    expect(mountChain("/Users/o", "/Users/o/.poundlock-dispatch/auto")).toEqual([
      { dir: "/Users/o", keep: "/Users/o/.poundlock-dispatch" },
      { dir: "/Users/o/.poundlock-dispatch", keep: "/Users/o/.poundlock-dispatch/auto" },
    ]);
    // A data folder outside home: nothing in home is allowed.
    expect(mountChain("/Users/o", "/Volumes/data/auto")).toEqual([{ dir: "/Users/o" }]);
  });
});

describe("what counts as showing home", () => {
  const home = "/Users/o";
  const auto = "/Users/o/.poundlock-dispatch/auto";
  const line = (id: number, point: string, type: string) =>
    `${id} 1 0:${id} / ${point} rw,relatime - ${type} src rw`;

  it("ignores folders the VM keeps on its own disk", () => {
    // A leftover empty ~/Library on the VM's disk, and only the auto folder shared.
    const mounts = parseMountinfo(
      [line(1, "/", "overlay"), line(2, home, "ext4"), line(3, auto, "virtiofs")].join("\n"),
    );
    const entries = [
      `${home}/Library`,
      `${home}/.poundlock-dispatch`,
      `${home}/.poundlock-dispatch/auto`,
    ];
    expect(exposedPaths(home, auto, entries, mounts)).toEqual([]);
  });

  it("names entries on a share, and shares deeper than the listing", () => {
    const shared = parseMountinfo([line(1, "/", "overlay"), line(2, home, "virtiofs")].join("\n"));
    expect(
      exposedPaths(home, auto, [`${home}/.ssh`, `${home}/.poundlock-dispatch`], shared),
    ).toEqual([`${home}/.ssh`]);
    const nested = parseMountinfo(
      [
        line(1, "/", "overlay"),
        line(2, home, "ext4"),
        line(3, `${home}/src/My\\040Code`, "fuse.sshfs"),
      ].join("\n"),
    );
    expect(exposedPaths(home, auto, [`${home}/src`], nested)).toEqual([`${home}/src/My Code`]);
  });

  it("counts every entry when there is no mount table to read", () => {
    expect(exposedPaths(home, auto, [`${home}/Library`], [])).toEqual([`${home}/Library`]);
  });
});

describe("container VM mounts", () => {
  it("names what the VM shows of home beyond the auto folder", async () => {
    const { home, paths } = await fakeHome([".ssh/id_ed25519", "Documents/notes.txt"]);
    await writeFile(join(paths.root, "..", "connection.secret.json"), "{}");
    const docker = await fakeDocker(["toolchain:test"]);
    const isolation = dockerIsolation({
      docker: docker.docker,
      env: docker.env,
      image: "toolchain:test",
      name: "probe",
      worktree: paths.root,
      readOnly: [],
    });
    const exposed = await isolation.exposure(home, paths.root);
    expect(exposed.sort()).toEqual(
      [
        join(home, ".poundlock-dispatch", "connection.secret.json"),
        join(home, ".ssh"),
        join(home, "Documents"),
      ].sort(),
    );
    const probe = (await docker.calls()).find((call) => call.includes("--mount"));
    expect(probe).toBeDefined();
    const text = probe?.join(" ") ?? "";
    expect(text).toContain("--network none");
    expect(text).toContain("--pull=never");
    expect(text).toContain(`type=bind,source=${home},target=${home},readonly`);
  });

  it("finds nothing when the VM mounts only the auto folder, or no home at all", async () => {
    const { home, paths } = await fakeHome();
    const docker = await fakeDocker(["toolchain:test"]);
    const isolation = dockerIsolation({
      docker: docker.docker,
      env: docker.env,
      image: "toolchain:test",
      name: "probe",
      worktree: paths.root,
      readOnly: [],
    });
    expect(await isolation.exposure(home, paths.root)).toEqual([]);
    expect(await isolation.exposure(join(home, "not-mounted"), paths.root)).toEqual([]);
  });

  it("refuses to start a run on a VM that shows home, leaving nothing behind", async () => {
    const env = await setup([".ssh/id_ed25519"]);
    const failure = await startAutoRun(env.request, env.deps).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("~/.ssh");
    expect(message).toContain(dedicatedVmCommand(env.paths.root));
    expect(message).toContain("colima ssh --profile dispatch-auto -- sudo sh -c");
    expect(message).toContain("--allow-home-in-vm");
    expect(existsSync(env.paths.lockFor(projectKey(env.source)))).toBe(false);
    expect(existsSync(env.paths.mirrors)).toBe(false);
  });

  it("starts on the dedicated profile's context by default and records it", async () => {
    const env = await setup();
    const { run, runDir, warnings } = await startAutoRun(env.request, env.deps);
    expect(warnings).toEqual([]);
    expect(run.dockerContext).toBe(AUTO_DOCKER_CONTEXT);
    expect((await readRunFile(runDir)).dockerContext).toBe("colima-dispatch-auto");
    expect((await env.docker.rawCalls()).every((call) => call[1] === AUTO_DOCKER_CONTEXT)).toBe(
      true,
    );
  });

  it("runs on a wide VM only when the owner overrides, and says so", async () => {
    const env = await setup([".ssh/id_ed25519"]);
    const { runDir, warnings } = await startAutoRun(
      { ...env.request, allowHomeInVm: true },
      env.deps,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Warning: .*~\/\.ssh.*--allow-home-in-vm/);
    expect((await readRunFile(runDir)).allowHomeInVm).toBe(true);
  });

  it("ends a run blocked when its VM starts showing home before the runner resumes", async () => {
    const env = await setup();
    const { run, runDir } = await startAutoRun(env.request, env.deps);
    await releaseProjectLock(env.paths, run.projectKey, run.runId);
    await writeFile(join(env.home, ".netrc"), "machine x password y");
    const output: string[] = [];
    const code = await runAuto(["run", runDir], {
      ...env.deps,
      entry: "unused",
      io: { out: (text) => output.push(text), err: (text) => output.push(text) },
      runner: { keepAwake: false, heartbeatMs: 50, controlPollMs: 20 },
    });
    expect(code).toBe(1);
    const state = await new AutoLedger(runDir).state();
    expect(state.outcome).toBe("blocked_for_input");
    expect(state.endReason).toContain("~/.netrc");
    expect(
      (await env.docker.calls()).some((call) => call[0] === "run" && call.includes("-d")),
    ).toBe(false);
  });
});

/**
 * Against a real VM, opt in: DISPATCH_DOCKER_TEST_IMAGE (a local image with
 * bash, never pulled), DISPATCH_DOCKER_TEST_CONTEXT, and
 * DISPATCH_DOCKER_TEST_HOME_VISIBLE=1 when that VM mounts the home folder.
 */
const image = process.env.DISPATCH_DOCKER_TEST_IMAGE;
const context = process.env.DISPATCH_DOCKER_TEST_CONTEXT;

describe.skipIf(!image || !context)("container VM mounts on a real VM", () => {
  it("reports home as the VM shows it", async () => {
    const isolation = dockerIsolation({
      context,
      image: image ?? "",
      name: "probe",
      worktree: homedir(),
      readOnly: [],
    });
    const home = await realpath(homedir());
    const exposed = await isolation.exposure(home, join(home, ".poundlock-dispatch", "auto"));
    if (process.env.DISPATCH_DOCKER_TEST_HOME_VISIBLE === "1")
      expect(exposed.length).toBeGreaterThan(0);
    else expect(exposed).toEqual([]);
  }, 60_000);
});
