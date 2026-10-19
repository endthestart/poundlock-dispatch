import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AutoLedger } from "@core/auto/ledger";
import {
  AutoPaths,
  acquireProjectLock,
  acquireRunnerLock,
  endRunWithoutRunner,
  exportRun,
  projectKey,
  readRunFile,
  releaseProjectLock,
  runnerAlive,
  runsForSource,
} from "@core/auto/runs";
import {
  type AutoPlanFile,
  type AutoStartRequest,
  limitsFor,
  planFromProject,
  startAutoRun,
} from "@core/auto/start";
import type { FileStore } from "@core/store";
import type { ProjectRecord } from "@shared/types";
import { afterAll, describe, expect, it } from "vitest";
import { fakeDocker } from "./support/fake-docker";
import { fakePoundlock } from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

const plan: AutoPlanFile = {
  cases: [
    { id: "C1", title: "one", objective: "write one", acceptanceCriteria: "a", dependsOn: [] },
  ],
  checks: ["true"],
};

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

async function setup(model: Parameters<typeof fakePoundlock>[0]["model"] = {}) {
  const source = await realpath(await tempDir("auto-start-src-"));
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "README.md"), "base\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const data = await tempDir("auto-start-data-");
  const paths = new AutoPaths(data);
  const server = await fakePoundlock({ model, respond: () => ({ text: "unused" }) });
  servers.push(server);
  const docker = await fakeDocker(["toolchain:test"]);
  const spawned: string[] = [];
  const deps = {
    paths,
    connection: async () => ({ url: server.url, token: server.token, roles: {}, profiles: {} }),
    project: async () => undefined,
    spawnRunner: (runDir: string) => void spawned.push(runDir),
    docker: docker.docker,
    dockerEnv: docker.env,
    freeBytes: async () => 100 * 1024 ** 3,
    home: await tempDir("auto-start-home-"),
  };
  const request: AutoStartRequest = {
    dir: source,
    plan,
    profile: "gate-model",
    image: "toolchain:test",
  };
  return { source, data, paths, server, docker, spawned, deps, request };
}

describe("auto start", () => {
  it("creates the run's mirror, worktree and run file, takes the lock, then starts the runner", async () => {
    const env = await setup();
    const { runDir, run, model } = await startAutoRun(env.request, env.deps);
    expect(env.spawned).toEqual([runDir]);
    expect(model.id).toBe("gate-model");
    const saved = await readRunFile(runDir);
    expect(saved).toMatchObject({
      runId: run.runId,
      source: env.source,
      baseCommit: git(env.source, "rev-parse", "HEAD"),
      branch: `auto/${run.runId}`,
      checks: ["true"],
      model: "gate-model",
      profileId: "p-gate",
      routingRevision: "r1",
      image: "toolchain:test",
      imageId: "sha256:fake-toolchain-test",
      container: `dispatch-${run.runId}`,
    });
    expect(JSON.stringify(saved)).not.toContain(env.server.token);
    expect(git(saved.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(saved.branch);
    expect(await readFile(env.paths.lockFor(projectKey(env.source)), "utf8")).toBe(run.runId);
    expect(env.server.counts.preflight).toBe(1);
    expect(run.runId).toMatch(/^auto-\d{8}-\d{6}-[0-9a-f]{4}$/);
    // One unfinished run per folder.
    await expect(startAutoRun(env.request, env.deps)).rejects.toThrow(
      `Run ${run.runId} of this folder is unfinished`,
    );
    expect(git(env.source, "branch", "--format=%(refname:short)")).toBe("main");
  });

  it("refuses a folder that is not a repository's top, or has uncommitted tracked changes", async () => {
    const env = await setup();
    const plain = await tempDir("auto-plain-");
    await expect(startAutoRun({ ...env.request, dir: plain }, env.deps)).rejects.toThrow(
      /is not a Git repository/,
    );
    await mkdir(join(env.source, "sub"));
    await expect(
      startAutoRun({ ...env.request, dir: join(env.source, "sub") }, env.deps),
    ).rejects.toThrow(`use its top folder, ${env.source}`);
    await writeFile(join(env.source, "README.md"), "changed\n");
    await expect(startAutoRun(env.request, env.deps)).rejects.toThrow(/uncommitted changes/);
  });

  it("needs a plan, checks and a saved connection", async () => {
    const env = await setup();
    await expect(startAutoRun({ ...env.request, plan: undefined }, env.deps)).rejects.toThrow(
      /no Dispatch project yet/,
    );
    await expect(
      startAutoRun({ ...env.request, plan: { ...plan, checks: [] } }, env.deps),
    ).rejects.toThrow(/needs the plan's checks/);
    await expect(
      startAutoRun(env.request, {
        ...env.deps,
        connection: async () => ({ url: "", token: "", roles: {}, profiles: {} }),
      }),
    ).rejects.toThrow(/No Poundlock connection/);
  });

  it("refuses an unknown profile, a short context and a model off the operator's network", async () => {
    const env = await setup();
    await expect(startAutoRun({ ...env.request, profile: "gpt-6" }, env.deps)).rejects.toThrow(
      "Poundlock does not offer gpt-6. It offers: gate-model.",
    );
    const short = await setup({ contextTokens: 65_536 });
    await expect(startAutoRun(short.request, short.deps)).rejects.toThrow(
      "gate-model has a 65536-token context; auto mode needs at least 128000.",
    );
    const external = await setup({ destination: "external" });
    await expect(startAutoRun(external.request, external.deps)).rejects.toThrow(
      /does not run on the operator's network/,
    );
  });

  it("keeps to the project's allowed worker profiles and its protected paths", async () => {
    const env = await setup();
    const project = (allowed: string[]) =>
      ({
        id: "p1",
        policy: {
          allowedWorkerProfileIds: allowed,
          verification: { commands: [], protectedPaths: ["fixtures/"] },
        },
      }) as unknown as ProjectRecord;
    const store = {} as FileStore;
    await expect(
      startAutoRun(env.request, {
        ...env.deps,
        project: async () => ({ project: project(["other"]), store }),
      }),
    ).rejects.toThrow("gate-model is not one of this project's allowed worker profiles.");
    const { run } = await startAutoRun(env.request, {
      ...env.deps,
      project: async () => ({ project: project(["p-gate"]), store }),
    });
    expect(run.scope.protectedPaths).toEqual(["fixtures/"]);
  });

  it("refuses without the image or enough free disk, and leaves no lock behind", async () => {
    const env = await setup();
    await expect(startAutoRun({ ...env.request, image: "missing:1" }, env.deps)).rejects.toThrow(
      "The image missing:1 is not on this machine.",
    );
    await expect(
      startAutoRun(env.request, { ...env.deps, freeBytes: async () => 1024 ** 3 }),
    ).rejects.toThrow(/needs \d+\.\d GB free for this run; there is 1\.0 GB/);
    expect(existsSync(env.paths.lockFor(projectKey(env.source)))).toBe(false);
    expect(env.spawned).toEqual([]);
  });

  it("reads the folder's approved plan when no plan file is given", async () => {
    const task = {
      id: "T1",
      title: "task",
      objective: "do it",
      workerPrompt: "",
      acceptanceCriteria: "done",
      dependsOn: [],
      difficulty: "medium",
      contextNote: "",
      status: "ready",
      repairCount: 0,
      attempts: [],
    };
    const store = (approved: boolean) =>
      ({
        layout: { root: "/data" },
        getPlan: async () => ({
          approved,
          verificationCommands: ["npm test"],
          frozenTests: [{ path: "tests/a.test.ts", sha256: "x", task: "T0" }],
        }),
        getTasks: async () => [task],
      }) as unknown as FileStore;
    const project = { id: "p1", policy: {} } as ProjectRecord;
    // The board's run follows the project: its frozen tests, the mutation check, new tasks.
    expect(await planFromProject({ project, store: store(true) })).toMatchObject({
      cases: [{ id: "T1", objective: "do it" }],
      checks: ["npm test"],
      frozenTests: ["tests/a.test.ts"],
      mutationCheck: true,
      board: { storeRoot: "/data", projectId: "p1" },
    });
    const off = { ...project, policy: { mutationCheck: false } } as ProjectRecord;
    expect((await planFromProject({ project: off, store: store(true) })).mutationCheck).toBe(false);
    await expect(planFromProject({ project, store: store(false) })).rejects.toThrow(
      /no approved plan/,
    );
  });

  it("derives the hard limit from the requested soft limit and case time", () => {
    expect(limitsFor({ hours: 2, caseMinutes: 30, maxCases: 5, maxTokens: 1000 })).toMatchObject({
      softHours: 2,
      hardHours: 2.75,
      caseMinutes: 30,
      maxCases: 5,
      maxProcessedTokens: 1000,
    });
  });
});

describe("auto runs on disk", () => {
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const child of children) child.kill("SIGKILL");
  });

  it("tells a live runner from a dead one or a reused pid", async () => {
    const runDir = await tempDir("auto-alive-");
    expect(await runnerAlive(runDir)).toBe(false);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", runDir], {
      stdio: "ignore",
    });
    children.push(holder);
    await writeFile(join(runDir, "runner.pid"), String(holder.pid));
    expect(await runnerAlive(runDir)).toBe(true);
    await expect(acquireRunnerLock(runDir)).rejects.toThrow(/Another runner/);
    const other = await tempDir("auto-alive-other-");
    // Our own pid is alive, but it is not that run's runner.
    await writeFile(join(other, "runner.pid"), String(process.pid));
    expect(await runnerAlive(other)).toBe(false);
    const release = await acquireRunnerLock(other);
    expect(await readFile(join(other, "runner.pid"), "utf8")).toBe(String(process.pid));
    await release();
    expect(existsSync(join(other, "runner.pid"))).toBe(false);
  });

  it("takes over a lock whose run has ended, and only the holder releases it", async () => {
    const env = await setup();
    const { run, runDir } = await startAutoRun(env.request, env.deps);
    const key = projectKey(env.source);
    await expect(acquireProjectLock(env.paths, key, "auto-other")).rejects.toThrow(/unfinished/);
    await releaseProjectLock(env.paths, key, "auto-other");
    expect(existsSync(env.paths.lockFor(key))).toBe(true);
    await endRunWithoutRunner(
      runDir,
      env.paths,
      { outcome: "cancelled_after_checkpoint", reason: "stopped" },
      { docker: env.docker.docker, env: env.docker.env },
    );
    expect(existsSync(env.paths.lockFor(key))).toBe(false);
    await writeFile(env.paths.lockFor(key), run.runId);
    await acquireProjectLock(env.paths, key, "auto-next");
    expect(await readFile(env.paths.lockFor(key), "utf8")).toBe("auto-next");
    expect((await runsForSource(env.paths, env.source)).map((r) => r.run.runId)).toEqual([
      run.runId,
    ]);
  });

  it("lets only one of two concurrent starts take the folder, and finds runs newest first", async () => {
    const env = await setup();
    const key = projectKey(env.source);
    const results = await Promise.allSettled(
      ["auto-a", "auto-b", "auto-c"].map((id) => acquireProjectLock(env.paths, key, id)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const holder = (await readFile(env.paths.lockFor(key), "utf8")).trim();
    expect(["auto-a", "auto-b", "auto-c"]).toContain(holder);
    await releaseProjectLock(env.paths, key, holder);
    const first = await startAutoRun(env.request, {
      ...env.deps,
      now: () => new Date("2026-09-29T10:00:00Z"),
    });
    await endRunWithoutRunner(
      first.runDir,
      env.paths,
      { outcome: "cancelled_after_checkpoint", reason: "stopped" },
      { docker: env.docker.docker, env: env.docker.env },
    );
    const second = await startAutoRun(env.request, {
      ...env.deps,
      now: () => new Date("2026-09-29T10:00:30Z"),
    });
    expect((await runsForSource(env.paths, env.source)).map((r) => r.run.runId)).toEqual([
      second.run.runId,
      first.run.runId,
    ]);
  });

  it("stops a run with no runner, keeping the interrupted attempt as a draft", async () => {
    const env = await setup();
    const { run, runDir } = await startAutoRun(env.request, env.deps);
    const ledger = new AutoLedger(runDir);
    await ledger.append({
      type: "run_started",
      runId: run.runId,
      cases: run.cases,
      limits: run.limits,
      supervision: "detached",
      baseCommit: run.baseCommit,
    });
    await ledger.append({ type: "attempt_started", caseId: "C1", attempt: 1, sessionKey: "s" });
    await writeFile(join(run.worktree, "half.txt"), "half\n");
    await endRunWithoutRunner(
      runDir,
      env.paths,
      { outcome: "cancelled_after_checkpoint", reason: "stopped while the runner was not running" },
      { docker: env.docker.docker, env: env.docker.env },
    );
    const state = await ledger.state();
    expect(state.outcome).toBe("cancelled_after_checkpoint");
    expect(state.cases[0].drafts[0]).toBe(`refs/auto/${run.runId}/drafts/C1-1-interrupted`);
    expect((await env.docker.calls()).some((c) => c[0] === "rm" && c.includes(run.container))).toBe(
      true,
    );
    await expect(exportRun(runDir)).rejects.toThrow(/no verified change to export yet/);
  });

  it("counts tasks merged by hand as applied and leaves a goal's blocked tasks to its Planner", async () => {
    const env = await setup();
    const { run, runDir } = await startAutoRun(env.request, env.deps);
    const ledger = new AutoLedger(runDir);
    await ledger.append({
      type: "run_started",
      runId: run.runId,
      cases: ["T1", "T2", "T3"].map((id) => ({
        id,
        title: id,
        objective: "o",
        acceptanceCriteria: "a",
        dependsOn: [],
      })),
      limits: run.limits,
      supervision: "detached",
      baseCommit: run.baseCommit,
    });
    // The owner fast-forwarded the folder to T1's checkpoint by hand; T2's is not in it.
    await writeFile(join(env.source, "t1.txt"), "t1\n");
    git(env.source, "add", "-A");
    git(env.source, "commit", "-q", "-m", "T1");
    const merged = git(env.source, "rev-parse", "HEAD");
    for (const [caseId, commit] of [
      ["T1", merged],
      ["T2", "0".repeat(40)],
    ]) {
      await ledger.append({ type: "case_started", caseId });
      await ledger.append({
        type: "checkpoint",
        caseId,
        commit,
        substantive: true,
        reviewed: false,
      });
      await ledger.append({ type: "case_accepted", caseId });
    }
    await ledger.append({ type: "case_started", caseId: "T3" });
    await ledger.append({ type: "case_blocked", caseId: "T3", reason: "no threads left" });
    await endRunWithoutRunner(
      runDir,
      env.paths,
      { outcome: "blocked_for_input", reason: "M1 has gaps" },
      { docker: env.docker.docker, env: env.docker.env },
    );
    const task = (id: string) => ({
      id,
      title: id,
      objective: "do it",
      workerPrompt: "",
      acceptanceCriteria: "done",
      dependsOn: [],
      difficulty: "medium",
      contextNote: "",
      status: "ready",
      repairCount: 0,
      attempts: [],
    });
    let tasks = ["T1", "T2", "T3", "T4"].map(task);
    const store = {
      layout: { root: "/data" },
      getPlan: async () => ({
        approved: true,
        verificationCommands: ["true"],
        milestones: [{ id: "M1" }],
      }),
      getTasks: async () => tasks.map((t) => ({ ...t })),
      saveTasks: async (_id: string, saved: typeof tasks) => void (tasks = saved),
    } as unknown as FileStore;
    const project = {
      id: "p1",
      policy: { verification: { commands: [] } },
    } as unknown as ProjectRecord;
    const next = await startAutoRun(
      { ...env.request, plan: undefined },
      { ...env.deps, project: async () => ({ project, store }) },
    );
    expect(tasks.map((t) => t.status)).toEqual(["applied", "ready", "ready", "ready"]);
    expect(next.run.cases.map((c) => c.id)).toEqual(["T2", "T4"]);
    expect(next.run.leftOut).toEqual(["T3"]);
  });

  it("records a run that never began as ended, so its folder is not left locked", async () => {
    const env = await setup();
    const { runDir } = await startAutoRun(env.request, env.deps);
    await endRunWithoutRunner(
      runDir,
      env.paths,
      { outcome: "blocked_for_input", reason: "The container runtime is not answering." },
      { docker: env.docker.docker, env: env.docker.env },
    );
    const state = await new AutoLedger(runDir).state();
    expect(state).toMatchObject({ outcome: "blocked_for_input", runId: expect.any(String) });
    expect(existsSync(env.paths.lockFor(projectKey(env.source)))).toBe(false);
  });
});
