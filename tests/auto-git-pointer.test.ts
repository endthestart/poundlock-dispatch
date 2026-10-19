/**
 * H4: the run's container cannot repoint the worktree's `.git`, and Dispatch
 * checks the pointer when a run ends and on export. A finished run's worktree
 * is removed once its work is exported.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dockerIsolation } from "@core/auto/isolation";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, type AutoRunFile, endRunWithoutRunner, exportRun } from "@core/auto/runs";
import { startAutoRun } from "@core/auto/start";
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

/** A started run with one verified checkpoint on its branch. */
async function runWithCheckpoint() {
  const source = await realpath(await tempDir("auto-h4-src-"));
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "README.md"), "base\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const paths = new AutoPaths(await tempDir("auto-h4-data-"));
  const server = await fakePoundlock({ respond: () => ({ text: "unused" }) });
  servers.push(server);
  const docker = await fakeDocker(["toolchain:test"]);
  const { run, runDir } = await startAutoRun(
    {
      dir: source,
      plan: {
        cases: [{ id: "C1", title: "one", objective: "o", acceptanceCriteria: "a", dependsOn: [] }],
        checks: ["true"],
      },
      profile: "gate-model",
      image: "toolchain:test",
    },
    {
      paths,
      connection: async () => ({ url: server.url, token: server.token, roles: {}, profiles: {} }),
      project: async () => undefined,
      spawnRunner: () => undefined,
      docker: docker.docker,
      dockerEnv: docker.env,
      freeBytes: async () => 100 * 1024 ** 3,
      home: await tempDir("auto-h4-home-"),
    },
  );
  await writeFile(join(run.worktree, "one.txt"), "one\n");
  const gitArgs = ["--git-dir", run.gitDir, "--work-tree", run.worktree];
  git(run.worktree, ...gitArgs, "add", "-A");
  git(run.worktree, ...gitArgs, "commit", "-q", "-m", "auto: C1 one");
  const commit = git(run.worktree, ...gitArgs, "rev-parse", "HEAD");
  const ledger = new AutoLedger(runDir);
  await ledger.append({
    type: "run_started",
    runId: run.runId,
    cases: run.cases,
    limits: run.limits,
    supervision: "detached",
    baseCommit: run.baseCommit,
  });
  await ledger.append({ type: "case_started", caseId: "C1" });
  await ledger.append({
    type: "checkpoint",
    caseId: "C1",
    commit,
    substantive: true,
    reviewed: false,
  });
  return { run, runDir, paths, docker, ledger };
}

/** What the model would do: a Git directory of its own, whose config runs a command. */
async function repoint(run: AutoRunFile): Promise<string> {
  const fake = join(run.worktree, ".hidden-git");
  await mkdir(join(fake, "objects"), { recursive: true });
  await mkdir(join(fake, "refs"), { recursive: true });
  await writeFile(join(fake, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(fake, "config"), "[core]\n\tfsmonitor = touch /tmp/owned\n");
  await rm(join(run.worktree, ".git"));
  await writeFile(join(run.worktree, ".git"), `gitdir: ${fake}\n`);
  return fake;
}

describe("auto-mode .git pointer", () => {
  it("puts back a repointed .git on export, and says so", async () => {
    const { run, runDir } = await runWithCheckpoint();
    await repoint(run);
    const out = join(await tempDir("auto-h4-out-"), "run.patch");
    const exported = await exportRun(runDir, out);
    expect(exported.warnings).toHaveLength(1);
    expect(exported.warnings[0]).toContain("had been changed");
    expect((await readFile(join(run.worktree, ".git"), "utf8")).trim()).toBe(
      `gitdir: ${run.gitDir}`,
    );
    // The run can still resume, so its worktree stays.
    expect(exported.removedWorktree).toBe(false);
    expect(existsSync(run.worktree)).toBe(true);
  });

  it("puts back a .git replaced by a folder when a run ends without its runner", async () => {
    const { run, runDir, paths, docker } = await runWithCheckpoint();
    await rm(join(run.worktree, ".git"));
    await mkdir(join(run.worktree, ".git"));
    await writeFile(join(run.worktree, ".git", "config"), "[core]\n\tpager = touch /tmp/owned\n");
    await endRunWithoutRunner(
      runDir,
      paths,
      { outcome: "cancelled_after_checkpoint", reason: "stopped" },
      { docker: docker.docker, env: docker.env },
    );
    expect((await readFile(join(run.worktree, ".git"), "utf8")).trim()).toBe(
      `gitdir: ${run.gitDir}`,
    );
  });

  it("leaves an intact pointer alone", async () => {
    const { runDir } = await runWithCheckpoint();
    const exported = await exportRun(runDir, join(await tempDir("auto-h4-ok-"), "run.patch"));
    expect(exported.warnings).toEqual([]);
  });

  it("removes a finished run's worktree after export, keeping the branch", async () => {
    const { run, runDir, ledger } = await runWithCheckpoint();
    await ledger.append({ type: "case_accepted", caseId: "C1" });
    await ledger.append({ type: "run_ended", outcome: "objective_met", reason: "done" });
    const out = join(await tempDir("auto-h4-done-"), "run.patch");
    const exported = await exportRun(runDir, out);
    expect(exported.removedWorktree).toBe(true);
    expect(existsSync(run.worktree)).toBe(false);
    expect(git(run.mirror, "--git-dir", run.mirror, "worktree", "list")).not.toContain(
      run.worktree,
    );
    expect(git(run.mirror, "--git-dir", run.mirror, "rev-parse", run.branch)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    // Exporting again still works from the mirror.
    const again = await exportRun(runDir, `${out}.again`);
    expect(again.files).toEqual(["one.txt"]);
  });

  it("refuses to write the patch inside the worktree the model can write", async () => {
    const { run, runDir } = await runWithCheckpoint();
    await expect(exportRun(runDir, join(run.worktree, "run.patch"))).rejects.toThrow(
      /inside the run's worktree/,
    );
  });
});

/**
 * Against a real container runtime, opt in: DISPATCH_DOCKER_TEST_IMAGE names a
 * local image with bash (never pulled), DISPATCH_DOCKER_TEST_DIR a folder the
 * VM mounts, and DISPATCH_DOCKER_TEST_CONTEXT optionally the docker context.
 */
const image = process.env.DISPATCH_DOCKER_TEST_IMAGE;
const realRoot = process.env.DISPATCH_DOCKER_TEST_DIR;

describe.skipIf(!image || !realRoot)("auto-mode .git pointer in a real container", () => {
  it("the container cannot rewrite, replace or remove .git", async () => {
    const root = join(realRoot ?? homedir(), `h4-${process.pid}-${Date.now()}`);
    const worktree = join(root, "work");
    await mkdir(worktree, { recursive: true });
    const pointer = "gitdir: /nowhere/worktrees/work\n";
    await writeFile(join(worktree, ".git"), pointer);
    const isolation = dockerIsolation({
      context: process.env.DISPATCH_DOCKER_TEST_CONTEXT,
      image: image ?? "",
      name: `dispatch-h4-test-${process.pid}`,
      worktree,
      readOnly: [],
    });
    try {
      await isolation.start();
      for (const attack of [
        "echo 'gitdir: /tmp/fake' > .git",
        "rm -f .git",
        "mv .git moved",
        "chmod u+w .git && echo x >> .git",
      ]) {
        const result = await isolation.exec(attack, { cwd: worktree, timeoutMs: 30_000 });
        expect(result.exitCode, attack).not.toBe(0);
      }
      // The rest of the worktree stays writable.
      const wrote = await isolation.exec("echo ok > file.txt", { cwd: worktree });
      expect(wrote.exitCode).toBe(0);
      expect(await readFile(join(worktree, ".git"), "utf8")).toBe(pointer);
    } finally {
      await isolation.remove();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
