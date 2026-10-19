/**
 * Merging an ended Autopilot run (ADR 016): a fast-forward of the owner's
 * folder to the run's last verified commit, refused whenever it would rewrite
 * anything of the owner's.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mergePreview, mergeRun } from "@core/auto/control";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, type AutoRunFile, projectKey, writeRunFile } from "@core/auto/runs";
import { DEFAULT_AUTO_LIMITS } from "@shared/auto-run";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

/** A folder, its mirror with a run branch one verified commit ahead, and the ended run. */
async function endedRun() {
  const source = await realpath(await tempDir("merge-src-"));
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "greet.py"), "def hello():\n    return 'hi'\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  const paths = new AutoPaths(await realpath(await tempDir("merge-data-")));
  const mirror = join(paths.mirrors, "m.git");
  await mkdir(paths.mirrors, { recursive: true });
  git(paths.mirrors, "clone", "-q", "--bare", source, mirror);
  const runId = "auto-20261014-130000-0001";
  const work = join(await tempDir("merge-work-"), "work");
  git(paths.mirrors, "clone", "-q", mirror, work);
  git(work, "checkout", "-q", "-b", `auto/${runId}`);
  await writeFile(
    join(work, "greet.py"),
    "def hello():\n    return 'hi'\n\n\ndef bye():\n    return 'bye'\n",
  );
  await mkdir(join(work, ".githooks"));
  await writeFile(join(work, ".githooks", "pre-commit"), "#!/bin/sh\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "T1: bye");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", `auto/${runId}`);
  const runDir = paths.runDir(runId);
  await mkdir(runDir, { recursive: true });
  await writeRunFile(runDir, {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    source,
    projectKey: projectKey(source),
    baseCommit: base,
    branch: `auto/${runId}`,
    mirror,
    cases: [],
  } as unknown as AutoRunFile);
  const ledger = new AutoLedger(runDir);
  await ledger.append({
    type: "run_started",
    runId,
    cases: [{ id: "T1", title: "bye", objective: "o", acceptanceCriteria: "a", dependsOn: [] }],
    limits: DEFAULT_AUTO_LIMITS,
    supervision: "detached",
    baseCommit: base,
  });
  await ledger.append({
    type: "checkpoint",
    caseId: "T1",
    commit: head,
    substantive: true,
    reviewed: false,
  });
  await ledger.append({ type: "case_accepted", caseId: "T1" });
  await ledger.append({
    type: "run_ended",
    outcome: "objective_met",
    reason: "every case verified",
  });
  return { source, runDir, base, head, work, mirror, runId };
}

it("fast-forwards a clean folder at the run's base, naming files that run here first", async () => {
  const { source, runDir, head } = await endedRun();
  const preview = await mergePreview(runDir);
  expect(preview).toMatchObject({ head, commits: 1, files: 2, caseIds: ["T1"] });
  expect(preview.runsHere).toEqual([".githooks/pre-commit"]);
  await mergeRun(runDir);
  expect(git(source, "rev-parse", "HEAD")).toBe(head);
  expect(git(source, "status", "--porcelain")).toBe("");
  await expect(mergePreview(runDir)).rejects.toThrow(/already merged/);
});

it("refuses a folder with uncommitted changes, or one that moved on", async () => {
  const dirty = await endedRun();
  await writeFile(join(dirty.source, "greet.py"), "changed\n");
  await expect(mergePreview(dirty.runDir)).rejects.toThrow(/uncommitted changes/);

  const moved = await endedRun();
  await writeFile(join(moved.source, "other.txt"), "x\n");
  git(moved.source, "add", "-A");
  git(moved.source, "commit", "-q", "-m", "owner work");
  await expect(mergeRun(moved.runDir)).rejects.toThrow(/moved on since the run started/);
  expect(git(moved.source, "log", "--format=%s", "-1")).toBe("owner work");
});

it("runs none of the owner's hooks, and never overwrites a file they ignore", async () => {
  const hooked = await endedRun();
  const ran = join(hooked.source, "hook-ran");
  await writeFile(join(hooked.source, ".git", "hooks", "post-merge"), `#!/bin/sh\ntouch ${ran}\n`);
  await chmod(join(hooked.source, ".git", "hooks", "post-merge"), 0o755);
  await mergeRun(hooked.runDir);
  expect(git(hooked.source, "rev-parse", "HEAD")).toBe(hooked.head);
  expect(existsSync(ran)).toBe(false);

  // The owner ignores a file of their own at a path the run adds.
  const ignored = await endedRun();
  await writeFile(join(ignored.source, ".git", "info", "exclude"), ".githooks/\n");
  await mkdir(join(ignored.source, ".githooks"));
  await writeFile(join(ignored.source, ".githooks", "pre-commit"), "mine\n");
  await expect(mergeRun(ignored.runDir)).rejects.toThrow();
  expect(await readFile(join(ignored.source, ".githooks", "pre-commit"), "utf8")).toBe("mine\n");
  expect(git(ignored.source, "rev-parse", "HEAD")).toBe(ignored.base);
});

it("merges again after a checkpoint, from the run's earlier commit", async () => {
  const run = await endedRun();
  await mergeRun(run.runDir);
  // The run went on after the owner merged at a checkpoint.
  await writeFile(join(run.work, "more.py"), "x = 1\n");
  git(run.work, "add", "-A");
  git(run.work, "commit", "-q", "-m", "T2: more");
  const later = git(run.work, "rev-parse", "HEAD");
  git(run.work, "push", "-q", "origin", `auto/${run.runId}`);
  const ledger = new AutoLedger(run.runDir);
  await ledger.append({
    type: "checkpoint",
    caseId: "T1",
    commit: later,
    substantive: true,
    reviewed: false,
  });
  const preview = await mergePreview(run.runDir);
  expect(preview).toMatchObject({ head: later, commits: 1, files: 1 });
  await mergeRun(run.runDir);
  expect(git(run.source, "rev-parse", "HEAD")).toBe(later);
});
