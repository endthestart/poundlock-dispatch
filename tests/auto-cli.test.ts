import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { autopilotView, stopRun } from "@core/auto/control";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, projectKey, readRunFile } from "@core/auto/runs";
import { afterAll, describe, expect, it } from "vitest";
import { type AutoCliDeps, parseAutoArgs, runAuto } from "../src/tui/auto";
import { fakeDocker } from "./support/fake-docker";
import { callsSinceLastUser, fakePoundlock, type ScriptedTurn } from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

const cleanup: Array<() => unknown> = [];
afterAll(async () => {
  for (const step of cleanup) await step();
});

/** One case: write done.txt, then finish. */
function script(request: Parameters<typeof callsSinceLastUser>[0]): ScriptedTurn {
  return callsSinceLastUser(request).length === 0
    ? { toolCalls: [{ name: "write", arguments: { path: "done.txt", content: "ok\n" } }] }
    : { toolCalls: [{ name: "finish_case", arguments: { status: "done", summary: "done" } }] };
}

async function setup() {
  const source = await realpath(await tempDir("auto-cli-src-"));
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "README.md"), "base\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const plan = join(await tempDir("auto-cli-plan-"), "plan.json");
  await writeFile(
    plan,
    JSON.stringify({
      checks: ["test -f README.md"],
      cases: [
        {
          id: "C1",
          title: "done",
          objective: "write done.txt",
          acceptanceCriteria: "it exists",
          dependsOn: [],
        },
      ],
    }),
  );
  const server = await fakePoundlock({ respond: script });
  cleanup.push(() => server.close());
  const docker = await fakeDocker(["toolchain:test"]);
  const paths = new AutoPaths(await tempDir("auto-cli-data-"));
  const output: string[] = [];
  const spawned: string[] = [];
  const interrupts: Array<() => void> = [];
  const deps: AutoCliDeps = {
    paths,
    connection: async () => ({ url: server.url, token: server.token, roles: {}, profiles: {} }),
    project: async () => undefined,
    entry: "unused",
    io: { out: (text) => output.push(text), err: (text) => output.push(text) },
    docker: docker.docker,
    dockerEnv: docker.env,
    spawnRunner: (runDir) => void spawned.push(runDir),
    sleep: async () => undefined,
    onInterrupt: (handler) => {
      interrupts.push(handler);
      return () => undefined;
    },
    runner: { keepAwake: false, heartbeatMs: 50, controlPollMs: 20 },
    freeBytes: async () => 100 * 1024 ** 3,
    home: await tempDir("auto-cli-home-"),
  };
  const cli = (...argv: string[]) => runAuto(argv, deps);
  const start = async () => {
    const code = await cli(
      "start",
      "--dir",
      source,
      "--image",
      "toolchain:test",
      "--plan",
      plan,
      "--profile",
      "gate-model",
      "--no-wait",
    );
    expect(code, output.join("")).toBe(0);
    return spawned.at(-1) ?? "";
  };
  const text = () => output.splice(0).join("");
  return {
    source,
    plan,
    server,
    docker,
    paths,
    output,
    spawned,
    interrupts,
    deps,
    cli,
    start,
    text,
  };
}

describe("auto command line", () => {
  it("parses commands and refuses what is missing or malformed", () => {
    expect(parseAutoArgs([])).toEqual({ command: "help" });
    expect(parseAutoArgs(["stop", "auto-1", "--now"])).toEqual({
      command: "stop",
      run: "auto-1",
      dir: undefined,
      now: true,
    });
    expect(
      parseAutoArgs([
        "start",
        "--dir",
        "/p",
        "--image",
        "img",
        "--check",
        "npm test",
        "--check",
        "npm run lint",
        "--prepare",
        "npm ci",
        "--allow-dependency-downloads",
        "--hours",
        "1.5",
      ]),
    ).toMatchObject({
      command: "start",
      checks: ["npm test", "npm run lint"],
      prepare: ["npm ci"],
      allowDependencyDownloads: true,
      limits: { hours: 1.5 },
      wait: true,
    });
    for (const [argv, message] of [
      [["start", "--image", "img"], /--dir is required/],
      [["start", "--dir", "/p"], /--image is required/],
      [["start", "--dir", "/p", "--image", "i", "--case-minutes", "1.5"], /positive whole number/],
      [["start", "--dir", "/p", "--image", "i", "--check", " "], /cannot be empty/],
      [["list"], /needs --dir/],
      [["status", "a", "b"], /at most one run/],
      [["frobnicate"], /Unknown auto command/],
    ] as const)
      expect(() => parseAutoArgs([...argv]), argv.join(" ")).toThrow(message);
  });

  it("prints usage, and exits 2 on a mistake", async () => {
    const env = await setup();
    expect(await env.cli("--help")).toBe(0);
    expect(env.text()).toContain("verified by the project's checks, not reviewed");
    expect(await env.cli()).toBe(2);
    expect(await env.cli("start", "--dir", env.source)).toBe(2);
    expect(env.text()).toContain('Run "auto --help" for usage.');
  });

  it("starts, then runs a case in the runner and exports it", async () => {
    const env = await setup();
    const runDir = await env.start();
    const started = env.text();
    expect(started).toContain("It runs in the background");
    expect(started).toContain("Commands: in a container (toolchain:test), no network");
    expect(started).toContain("verified by the checks, not reviewed");
    expect(await env.cli("run", runDir)).toBe(0);
    const state = await new AutoLedger(runDir).state();
    expect(state.outcome).toBe("objective_met");
    expect(existsSync(env.paths.lockFor(projectKey(env.source)))).toBe(false);
    const run = await readRunFile(runDir);
    expect((await env.docker.calls()).some((c) => c[0] === "rm" && c.includes(run.container))).toBe(
      true,
    );
    expect(await env.cli("status", "--dir", env.source)).toBe(0);
    expect(env.text()).toContain("Cases 1/1 verified, not reviewed");
    expect(await env.cli("list", "--dir", env.source)).toBe(0);
    expect(env.text()).toContain(`${run.runId}  1/1 verified, not reviewed  every case verified`);
    const out = join(await tempDir("auto-cli-out-"), "run.patch");
    expect(await env.cli("export", run.runId, "--out", out)).toBe(0);
    expect(env.text()).toContain("verified, not reviewed");
    expect(await env.cli("resume", run.runId)).toBe(0);
    expect(env.text()).toContain("nothing to resume");
    expect(await env.cli("watch", run.runId)).toBe(0);
    expect(env.text()).toContain("Ended: every case verified (not reviewed)");
  });

  it("ends a run it cannot work as blocked, releasing the folder", async () => {
    const env = await setup();
    const runDir = await env.start();
    const broken = { ...env.deps, dockerEnv: { ...env.deps.dockerEnv, FAKE_DOCKER_IMAGES: "" } };
    expect(await runAuto(["run", runDir], broken)).toBe(1);
    const state = await new AutoLedger(runDir).state();
    expect(state.outcome).toBe("blocked_for_input");
    expect(state.endReason).toContain("is not on this machine");
    expect(existsSync(env.paths.lockFor(projectKey(env.source)))).toBe(false);
    expect(await readRunFile(runDir).then((run) => run.runId)).toBeTruthy();
  });

  it("stops a live runner through its inbox, and a dead one directly", async () => {
    const env = await setup();
    const runDir = await env.start();
    const holder: ChildProcess = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)", runDir],
      {
        stdio: "ignore",
      },
    );
    cleanup.push(() => holder.kill("SIGKILL"));
    await writeFile(join(runDir, "runner.pid"), String(holder.pid));
    expect(await env.cli("stop", "--dir", env.source, "--now")).toBe(0);
    expect(env.text()).toContain("stop now");
    expect(await new AutoLedger(runDir).readInbox()).toMatchObject([{ cmd: "stop_now" }]);
    expect(await env.cli("resume", "--dir", env.source)).toBe(1);
    expect(env.text()).toContain(`already running (pid ${holder.pid})`);
    holder.kill("SIGKILL");
    await new Promise((done) => holder.once("exit", done));
    expect(await env.cli("stop", "--dir", env.source)).toBe(0);
    expect(env.text()).toContain("The runner was not running. The run is stopped");
    expect((await new AutoLedger(runDir).state()).outcome).toBe("cancelled_after_checkpoint");
    expect(await env.cli("resume", "--dir", env.source)).toBe(0);
    expect(env.spawned.at(-1)).toBe(runDir);
  });

  it("shows a run to the app: starting, interrupted, then stopped", async () => {
    const env = await setup();
    const runDir = await env.start();
    const run = await readRunFile(runDir);
    const view = await autopilotView(env.paths, env.source);
    expect(view).toMatchObject({
      runId: run.runId,
      phase: "preparing",
      branch: run.branch,
      cases: [{ id: "C1", stage: "pending" }],
    });
    expect(view?.board).toBeUndefined();
    // No runner a minute later: interrupted, and Resume is the way on.
    const later = new Date(Date.parse(run.createdAt) + 60_000);
    expect((await autopilotView(env.paths, env.source, later))?.phase).toBe("interrupted");
    expect(
      await stopRun(env.paths, runDir, "after_case", {
        docker: env.docker.docker,
        env: env.docker.env,
      }),
    ).toBe("stopped");
    expect(await autopilotView(env.paths, env.source, later)).toMatchObject({
      phase: "ended",
      outcome: "cancelled_after_checkpoint",
    });
    expect(await stopRun(env.paths, runDir, "now")).toBe("already_ended");
  });

  it("leaves a watched run running on Ctrl+C", async () => {
    const env = await setup();
    const runDir = await env.start();
    env.text();
    const watching = env.cli("watch", "--dir", env.source);
    // Interrupt only once watch has installed its handler; a fixed delay raced on a busy host.
    for (let waited = 0; !env.interrupts.length && waited < 5000; waited += 10)
      await new Promise((done) => setTimeout(done, 10));
    expect(env.interrupts.length).toBeGreaterThan(0);
    for (const interrupt of env.interrupts) interrupt();
    expect(await watching).toBe(0);
    expect(env.text()).toContain("Left the run; it goes on.");
    expect((await new AutoLedger(runDir).state()).outcome).toBeUndefined();
  });
});

describe("the limits line", () => {
  it("writes hours as a person would", async () => {
    const { hours } = await import("../src/tui/auto");
    expect(hours(2)).toBe("2 h");
    expect(hours(2.5833333333333335)).toBe("2 h 35 min");
    expect(hours(0.25)).toBe("15 min");
  });
});
