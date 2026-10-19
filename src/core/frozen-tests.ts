/**
 * Tests written first and then frozen. A test task's accepted test files are
 * recorded with their SHA-256; a later attempt that changes one is refused at
 * acceptance, and workers may not edit them. Changing one on purpose takes a
 * task marked `changesFrozenTests`, which the owner sees on the plan card. The
 * manager never needs write access for any of this.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FrozenTest, TaskRecord } from "@shared/types";
import { DEFAULT_EXCLUSIONS } from "@shared/types";
import ignore from "ignore";
import { classifyAttemptFailure } from "./failure-class";
import { isTestPath } from "./task-size";

async function sha256Of(root: string, path: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  } catch {
    return undefined;
  }
}

const excluded = ignore().add(DEFAULT_EXCLUSIONS);

/**
 * Whether a path can be a frozen test. Build output never is: SwiftPM writes
 * test_entry_point.o and friends under .build, and freezing them made every
 * later build look like a changed test (13 Oct).
 */
export function freezable(path: string): boolean {
  return !excluded.ignores(path);
}

/**
 * A file whose name says it holds tests: what a tests-first task freezes.
 * Helpers and fixtures beside them stay free to grow, so a later milestone can
 * add a fixture to a helper an earlier milestone's tests share.
 */
export function isTestFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return (
    /^test_.+|_test\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$/i.test(name) ||
    /Tests?\.(swift|java|kt|cs)$/.test(name)
  );
}

/** The frozen tests that count, without any build output recorded before 0.2.20. */
export function frozenTestsIn(frozen: FrozenTest[] | undefined): FrozenTest[] {
  return (frozen ?? []).filter((test) => freezable(test.path));
}

/** Frozen tests among the files an attempt reported changing. */
export function frozenAmong(frozen: FrozenTest[], changedFiles: string[]): string[] {
  const changed = new Set(changedFiles);
  return frozen
    .filter((test) => freezable(test.path) && changed.has(test.path))
    .map((test) => test.path);
}

/**
 * Frozen tests whose content in `root` no longer matches, including deleted
 * ones. Used for interactive work, which edits the folder directly.
 */
export async function frozenDrift(frozen: FrozenTest[], root: string): Promise<string[]> {
  const drifted: string[] = [];
  for (const test of frozen) {
    if (freezable(test.path) && (await sha256Of(root, test.path)) !== test.sha256)
      drifted.push(test.path);
  }
  return drifted;
}

/**
 * The frozen list after `task` was accepted: its changed test files (all its
 * changed files when it wrote tests but none look like tests) recorded or
 * refreshed with their content in `root`.
 */
export async function freezeAccepted(
  existing: FrozenTest[],
  task: Pick<TaskRecord, "title" | "writesTests" | "changesFrozenTests">,
  changedFiles: string[],
  root: string,
): Promise<FrozenTest[]> {
  if (!task.writesTests && !task.changesFrozenTests) return existing;
  const files = changedFiles.filter(freezable);
  const tests = files.filter(isTestFile);
  const candidates = tests.length || !task.writesTests ? tests : files;
  const next = new Map(
    existing.filter((test) => freezable(test.path)).map((test) => [test.path, test]),
  );
  for (const path of candidates) {
    const sha256 = await sha256Of(root, path);
    if (sha256) next.set(path, { path, sha256, task: task.title });
    else next.delete(path);
  }
  return [...next.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Where a refused attempt's version of a frozen test is kept, inside the project. */
export const FROZEN_EDITS_FOLDER = ".dispatch/frozen-edits";

/**
 * Keep a copy of each frozen test's accepted content in `store`, named by its
 * SHA-256, when the file in `root` still has it. Without Git a worker that
 * edited a frozen test had nothing to restore it from; one searched /tmp and
 * /var/folders for an original (14 Oct).
 */
export async function keepFrozenCopies(
  frozen: FrozenTest[],
  root: string,
  store: string,
): Promise<void> {
  for (const test of frozenTestsIn(frozen)) {
    const target = join(store, test.sha256);
    if (
      await stat(target).then(
        () => true,
        () => false,
      )
    )
      continue;
    const content = await readFile(join(root, test.path)).catch(() => undefined);
    if (!content || createHash("sha256").update(content).digest("hex") !== test.sha256) continue;
    await mkdir(store, { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
}

/**
 * Put drifted frozen tests in `root` back from their kept copies. The
 * attempt's version of each goes to FROZEN_EDITS_FOLDER under the same path,
 * so new tests in it can move to a new file. Returns the paths restored; a
 * test without a kept copy is left as it is.
 */
export async function restoreFrozenTests(
  frozen: FrozenTest[],
  paths: string[],
  root: string,
  store: string,
): Promise<string[]> {
  const restored: string[] = [];
  for (const path of paths) {
    const test = frozen.find((item) => item.path === path);
    const original = test && (await readFile(join(store, test.sha256)).catch(() => undefined));
    if (!original) continue;
    const edited = await readFile(join(root, path)).catch(() => undefined);
    if (edited) {
      const kept = join(root, FROZEN_EDITS_FOLDER, path);
      await mkdir(dirname(kept), { recursive: true });
      await writeFile(kept, edited);
    }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), original);
    restored.push(path);
  }
  return restored;
}

export function frozenRefusal(paths: string[], restored: string[] = []): string {
  const left = paths.filter((path) => !restored.includes(path));
  return [
    `This attempt changed frozen tests: ${paths.join(", ")}. Tests are frozen once their test task is accepted, so passing checks here may mean the tests were weakened.`,
    restored.length &&
      `Dispatch put ${restored.join(", ")} back to the frozen content and kept the attempt's version under ${FROZEN_EDITS_FOLDER}/ at the same path. Call request_repair: the worker moves any new tests from that copy into a new test file and makes the code pass the frozen tests unchanged.`,
    left.length && `Call request_repair and tell the worker to restore ${left.join(", ")} exactly.`,
    "To change a test on purpose, plan a task with changesFrozenTests; the owner sees it on the plan card.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * True when a tests-first task's checks failed the way tests written before
 * their code should: the checks ran, nothing points at the environment, and
 * the attempt changed test files. Such a task is accepted red; the next
 * implementation task must turn its frozen tests green. Requiring green here
 * made every tests-first task impossible to accept.
 */
export function expectsRedTests(task: TaskRecord, changedFiles: string[]): boolean {
  if (!task.writesTests) return false;
  const attempt = task.attempts.at(-1);
  const verification = attempt?.result?.verification;
  if (attempt?.status !== "completed" || !verification) return false;
  const commands = verification.commands ?? [];
  if (!commands.some((command) => typeof command.exitCode === "number")) return false;
  const output = commands.map((command) => `${command.error ?? ""} ${command.output}`).join("\n");
  if (classifyAttemptFailure({ verificationOutput: output }) === "environment") return false;
  return changedFiles.some(isTestPath);
}

/** Frozen tests a worker brief names, by path or file name. */
export function frozenNamedIn(frozen: FrozenTest[], text: string): string[] {
  return frozen
    .filter((test) => {
      const name = basename(test.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text.includes(test.path) || new RegExp(`(^|[^\\w.-])${name}\\b`).test(text);
    })
    .map((test) => test.path);
}

/**
 * Said once when a repair or delegated task names frozen tests. Its worker
 * cannot change them, so a brief that needs one changed spends an attempt on
 * a refusal, as when a manager asks for a frozen test's stubs to be removed.
 * Naming one only to make it pass is fine.
 */
export function frozenBriefNote(paths: string[]): string {
  return `This brief names frozen tests: ${paths.join(", ")}. A worker cannot change them, and acceptance refuses a change. If the work needs them changed, plan a task with changesFrozenTests (propose_plan; the owner sees it on the plan card). If the worker only has to make them pass, call this tool again.`;
}
