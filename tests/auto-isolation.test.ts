import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dockerIsolation, dockerRunArgs, isRuntimeFailure } from "@core/auto/isolation";
import { describe, expect, it } from "vitest";
import { fakeDocker } from "./support/fake-docker";
import { tempDir } from "./support/temp-dir";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((done) => setTimeout(done, 25));
  return check();
}

async function setup(images?: string[]) {
  const fake = await fakeDocker(images);
  const worktree = await tempDir("auto-iso-work-");
  const isolation = dockerIsolation({
    docker: fake.docker,
    context: "colima-dispatch-auto",
    image: "toolchain:test",
    name: "dispatch-auto-r1",
    worktree,
    readOnly: ["/data/auto/mirrors/m.git"],
    env: fake.env,
  });
  return { fake, worktree, isolation };
}

describe("container isolation", () => {
  it("runs the container with no network, no capabilities and only the worktree writable", () => {
    const args = dockerRunArgs(
      {
        image: "toolchain:test",
        name: "dispatch-auto-r1",
        worktree: "/data/auto/runs/r1/work",
        readOnly: ["/data/auto/mirrors/m.git"],
        user: "501:20",
      },
      {
        name: "dispatch-auto-r1",
        detach: true,
        network: false,
        entrypoint: "sleep",
        args: ["infinity"],
      },
    );
    const text = args.join(" ");
    expect(text).toContain("--network none");
    expect(text).toContain("--cap-drop ALL");
    expect(text).toContain("--security-opt no-new-privileges");
    expect(text).toContain("--pids-limit 1024");
    // An init reaps what tests leak, so zombies never fill the process limit.
    expect(text).toContain("--init --ulimit core=0 --pids-limit");
    expect(text).toContain("--user 501:20");
    expect(args.filter((a, i) => args[i - 1] === "-v")).toEqual([
      "/data/auto/runs/r1/work:/data/auto/runs/r1/work",
      // After the worktree, so the pointer lies over it read-only (H4).
      "/data/auto/runs/r1/work/.git:/data/auto/runs/r1/work/.git:ro",
      "/data/auto/mirrors/m.git:/data/auto/mirrors/m.git:ro",
    ]);
    expect(text).not.toContain(homedir());
    expect(text).not.toMatch(/docker\.sock|--privileged/);
    expect(text).toContain("--entrypoint sleep");
    expect(args.slice(-2)).toEqual(["toolchain:test", "infinity"]);
  });

  it("never pulls, runs the recorded image ID, and leaves the VM memory to spare", async () => {
    const fake = await fakeDocker(["toolchain:test"]);
    const worktree = await tempDir("auto-iso-l31-");
    const base = {
      docker: fake.docker,
      env: fake.env,
      image: "toolchain:test",
      name: "dispatch-auto-l31",
      worktree,
      readOnly: [],
    };
    const { imageId } = await dockerIsolation(base).check();
    expect(imageId).toBe("sha256:fake-toolchain-test");
    const isolation = dockerIsolation({ ...base, imageId });
    await isolation.check();
    await isolation.start();
    const created = (await fake.calls()).find((call) => call[0] === "run") ?? [];
    expect(created).toContain("--pull=never");
    expect(created).toContain("--log-driver=none");
    // Three quarters of the fake VM's 8 GiB, with no swap beyond it.
    expect(created.slice(created.indexOf("--memory"), created.indexOf("--memory") + 4)).toEqual([
      "--memory",
      "6144m",
      "--memory-swap",
      "6144m",
    ]);
    expect(created).toContain(imageId);
    expect(created).not.toContain("toolchain:test");
    // The tag is gone from this machine, and the ID with it: the run cannot continue.
    const gone = dockerIsolation({
      ...base,
      imageId,
      env: { ...fake.env, FAKE_DOCKER_IMAGES: "other:1" },
    });
    await expect(gone.check()).rejects.toThrow(/is not on this machine any more/);
  });

  it("makes a container again when it was created with other flags", async () => {
    const { fake, worktree, isolation } = await setup();
    await isolation.start();
    // An older Dispatch made this run's container without the read-only `.git`.
    const file = join(fake.state, "containers", "dispatch-auto-r1.json");
    const old = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...old, labels: ["app.poundlock.dispatch.auto=1"] }));
    await isolation.start();
    const calls = await fake.calls();
    expect(calls.filter((call) => call.includes("run"))).toHaveLength(2);
    expect(calls.some((call) => call.includes("rm") && call.includes("dispatch-auto-r1"))).toBe(
      true,
    );
    const recreated = JSON.parse(await readFile(file, "utf8"));
    expect(recreated.mounts).toContain(`${worktree}/.git:${worktree}/.git:ro`);
    // The same flags again: reused, not made a third time.
    await isolation.start();
    expect((await fake.calls()).filter((call) => call.includes("run"))).toHaveLength(2);
  });

  it("tells the Docker client failing from the command failing", () => {
    expect(
      isRuntimeFailure({
        exitCode: 1,
        output:
          "Cannot connect to the Docker daemon at unix:///x/docker.sock. Is the docker daemon running?\n",
      }),
    ).toBe(true);
    expect(
      isRuntimeFailure({
        exitCode: 1,
        output: "Error response from daemon: container x is not running",
      }),
    ).toBe(true);
    expect(
      isRuntimeFailure({
        exitCode: 1,
        output: "FAILED test_loop: RuntimeError: event loop is not running",
      }),
    ).toBe(false);
    expect(isRuntimeFailure({ exitCode: 0, output: "Error response from daemon: nothing" })).toBe(
      false,
    );
  });

  it("refuses to run without the runtime or the image, and never pulls", async () => {
    const { fake, isolation } = await setup(["other:1"]);
    await expect(isolation.check()).rejects.toThrow(
      "The image toolchain:test is not on this machine. Build or pull it yourself; Dispatch never downloads it.",
    );
    expect((await fake.calls()).some((call) => call.includes("pull"))).toBe(false);
    const missing = dockerIsolation({
      docker: join(await tempDir("no-docker-"), "docker"),
      image: "toolchain:test",
      name: "x",
      worktree: "/tmp",
      readOnly: [],
    });
    await expect(missing.check()).rejects.toThrow(/is not installed or not on the PATH/);
  });

  it("creates the container once and runs commands in it, in their folder", async () => {
    const { fake, worktree, isolation } = await setup();
    await isolation.check();
    await isolation.start();
    await isolation.start();
    const created = (await fake.rawCalls()).filter((call) => call.includes("run"));
    expect(created).toHaveLength(1);
    expect(created[0].slice(0, 3)).toEqual(["--context", "colima-dispatch-auto", "run"]);
    const result = await isolation.exec("pwd; echo out; echo err >&2; exit 3", { cwd: worktree });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.output).toContain(worktree.split("/").at(-1));
    expect(isolation.description).toBe(
      "a container (toolchain:test), no network (context colima-dispatch-auto)",
    );
  });

  it("stops everything in the container when a command times out or is cancelled", async () => {
    const { worktree, isolation } = await setup();
    await isolation.start();
    const timed = await isolation.exec("echo $$ > leader.pid; sleep 30", {
      cwd: worktree,
      timeoutMs: 300,
    });
    expect(timed).toMatchObject({ exitCode: null, error: "Command timed out after 0 s" });
    const controller = new AbortController();
    const running = isolation.exec("sleep 30", { cwd: worktree, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect(await running).toMatchObject({ exitCode: null, error: "Cancelled" });
  });

  it("kills commands an attempt left running in the background", async () => {
    const { worktree, isolation } = await setup();
    await isolation.start();
    const started = await isolation.exec("sleep 30 >/dev/null 2>&1 & echo $!", { cwd: worktree });
    const pid = Number(started.output.trim());
    expect(alive(pid)).toBe(true);
    await isolation.killAll();
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("removes a setup container that timed out, so nothing keeps installing", async () => {
    const { fake, worktree, isolation } = await setup();
    const result = await isolation.prepare("echo $$ > setup.pid; sleep 30", {
      network: true,
      timeoutMs: 300,
    });
    expect(result).toMatchObject({ exitCode: null, error: "Command timed out after 0 s" });
    const calls = await fake.calls();
    expect(
      calls.filter((c) => c.includes("rm") && c.includes("dispatch-auto-r1-setup")).length,
    ).toBe(2);
    const pid = Number((await readFile(join(worktree, "setup.pid"), "utf8")).trim());
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("gives setup the network only when downloads are approved", async () => {
    const { fake, worktree, isolation } = await setup();
    const offline = await isolation.prepare("echo prepared > made.txt", { network: false });
    expect(offline.exitCode).toBe(0);
    await isolation.prepare("true", { network: true });
    const runs = (await fake.calls()).filter((call) => call.includes("--rm"));
    // A networked setup is preceded by a probe that this machine is out of reach (L29).
    expect(runs.map((call) => call[call.indexOf("--network") + 1])).toEqual([
      "none",
      "bridge",
      "bridge",
    ]);
    expect(runs[1].at(-1)).toMatch(/REACHED:host\.lima\.internal/);
    // The networked setup does not see the mirror.
    expect(runs[2].some((arg) => arg.endsWith(":ro") && !arg.includes(".git"))).toBe(false);
    expect(runs[0][runs[0].indexOf("--name") + 1]).toBe("dispatch-auto-r1-setup");
    expect(runs[0].slice(-2)).toEqual(["-c", "echo prepared > made.txt"]);
    expect(runs[0][runs[0].indexOf("-w") + 1]).toBe(worktree);
  });
});

describe("a networked setup (L29)", () => {
  it("is refused when a container can reach this machine, before anything runs", async () => {
    const fake = await fakeDocker();
    const worktree = await tempDir("auto-l29-");
    // The fake runs containers on this machine, so loopback stands in for the host.
    const isolation = dockerIsolation({
      docker: fake.docker,
      env: fake.env,
      image: "toolchain:test",
      name: "dispatch-auto-l29",
      worktree,
      readOnly: [],
      hostNames: ["127.0.0.1"],
    });
    await expect(isolation.prepare("touch installed", { network: true })).rejects.toThrow(
      /can reach this Mac \(127\.0\.0\.1\).*colima ssh --profile dispatch-auto -- sudo sh -c/,
    );
    const setups = (await fake.calls()).filter((call) => call.includes("dispatch-auto-l29-setup"));
    expect(setups.filter((call) => call[0] === "run")).toEqual([]);
  });
});

describe("a networked setup's name lookup", () => {
  it("is refused with the fix when containers cannot look up names", async () => {
    const fake = await fakeDocker();
    const bin = await tempDir("auto-dns-bin-");
    // The fake runs containers here: a getent that always fails stands in for a dead resolver.
    await writeFile(join(bin, "getent"), "#!/bin/sh\nexit 2\n");
    await chmod(join(bin, "getent"), 0o755);
    const worktree = await tempDir("auto-dns-");
    const isolation = dockerIsolation({
      docker: fake.docker,
      env: { ...fake.env, PATH: `${bin}:${process.env.PATH}` },
      image: "toolchain:test",
      name: "dispatch-auto-dns",
      worktree,
      readOnly: [],
      hostNames: [],
    });
    await expect(isolation.prepare("touch installed", { network: true })).rejects.toThrow(
      /cannot look up names.*public DNS servers.*colima ssh --profile dispatch-auto/,
    );
    const setups = (await fake.calls()).filter((call) => call.includes("dispatch-auto-dns-setup"));
    expect(setups.filter((call) => call[0] === "run")).toEqual([]);
  });
});

describe("container isolation under a narrowed PATH", () => {
  it("keeps the docker program and environment it was created with", async () => {
    const fake = await fakeDocker();
    const bin = await tempDir("auto-iso-bin-");
    await symlink(fake.docker, join(bin, "docker"));
    const worktree = await tempDir("auto-iso-path-");
    const isolation = dockerIsolation({
      image: "toolchain:test",
      name: "dispatch-auto-path",
      worktree,
      readOnly: [],
      env: { ...fake.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const saved = process.env.PATH;
    // A worker attempt narrows PATH to the host tool folders while it runs.
    process.env.PATH = "/nonexistent";
    try {
      await isolation.start();
      expect((await isolation.exec("echo contained", { cwd: worktree })).output).toContain(
        "contained",
      );
    } finally {
      process.env.PATH = saved;
    }
    expect((await fake.calls()).some((call) => call.at(-1) === "echo contained")).toBe(true);
  });
});
