import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import type { ProjectRecord, ProjectStatus, TaskRecord, VerificationView } from "@shared/types";
import { defaultBudget, defaultPolicy } from "@shared/types";
import { newId, nowIso } from "./ids.js";
import { projectFiles } from "./paths.js";
import { FileStore } from "./store.js";
import { workerHintFields } from "./task-hints.js";
import { newWorkflowIdentity } from "./workflow-identity.js";
import { materializeSnapshot } from "./workspace.js";

/**
 * Poundlock job statuses that mean the job is still ours to wait on. Two
 * copies of this list drifting apart would make the orchestrator and the
 * status view disagree about whether a run is finished.
 */
export const ACTIVE_JOB: ReadonlySet<string> = new Set([
  "submitted",
  "waiting_node",
  "waiting_capacity",
  "preparing",
  "ready",
  "running",
]);

export async function createProjectFromFiles(options: {
  store: FileStore;
  name: string;
  source: ProjectRecord["source"];
  files: Array<{ path: string; content: Buffer; executable: boolean }>;
  policy?: Partial<ProjectRecord["policy"]>;
}): Promise<ProjectRecord> {
  const id = newId("proj");
  const files = projectFiles(options.store.layout.root, id);
  await mkdir(files.dir, { recursive: true, mode: 0o700 });
  const revision = await materializeSnapshot(
    files.workspace,
    options.files,
    "Captured project base",
  );
  const now = nowIso();
  const policy = { ...defaultPolicy(), ...options.policy };
  const identity = newWorkflowIdentity();
  const project: ProjectRecord = {
    id,
    name: options.name,
    archived: false,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: { ...options.source, baseRevision: revision },
    policy,
    budget: defaultBudget(),
    integration: {
      headRevision: revision,
      expectedBase: revision,
      appliedPatchSha256: [],
    },
    planRevision: 0,
    workflowId: identity.workflowId,
    managerSessionId: identity.managerConversationId,
    eventCursor: 0,
  };
  await options.store.saveProject(project);
  await options.store.saveTasks(id, []);
  await options.store.saveMessages(id, []);
  return project;
}

/**
 * The one statement of Dispatch's verification gate. Referenced by the manager
 * system prompt, the plan authority text, and the manager review guidance so
 * the rule cannot drift between them. Enforcement itself lives in
 * orchestration.ts and is not affected by this text.
 */
export const UNVERIFIED_CODE_REJECTED = "Unverified code is rejected";

const TESTS_FIRST =
  "This task writes tests before their code. Write them against the planned API. Where that code does not exist yet, add the smallest stubs to the source files (bodies that fail, such as todo!()) so the tests compile; never put stubs or stand-ins inside test files. Assert the finished behaviour: never mark a test as expected to fail or panic because its code is missing (should_panic, xfail, skip). The new tests are expected to fail until the implementation task.";

function frozenNote(frozenPaths: string[]): string {
  return `These test files are frozen: read and run them, never change them, and make them pass by changing the source: ${frozenPaths.join(", ")}`;
}

/** Source files that draw what a user sees. */
const UI_FILE =
  /\.(swift|tsx|jsx|vue|svelte|html|css|scss|xib|storyboard|kt|dart)$|(^|\/)(views?|ui|components|screens|windows?)\//i;

/** Whether a task changes what a user sees, judged from the files it names. */
export function changesUi(task: Pick<TaskRecord, "filesToTouch">): boolean {
  return (task.filesToTouch ?? []).some(
    (path) => UI_FILE.test(path) && !/(^|\/)tests?\//i.test(path),
  );
}

/**
 * Snapshot evidence, in the brief of a task that changes UI. The same request
 * in the standing worker prompt was not followed by local workers (13 Oct).
 */
const UI_EVIDENCE =
  "This task changes what a user sees. Test the changed UI through the app's own controllers, headlessly: never order a window front, show an alert or open a modal panel in a test, and run UI work on the main thread (Swift Testing: @MainActor). Have a test render each changed view off-screen to .dispatch/evidence/<view>.png (AppKit: bitmapImageRepForCachingDisplay(in:) and cacheDisplay(in:to:); web: a headless browser screenshot), never a screen capture. Dispatch shows those images to the owner.";

/**
 * Builds the instructions an interactive worker receives for one task, as the
 * JSON body of its first message.
 *
 * The manager's own hints (its context note, the files to change, the code to
 * reuse) follow the instructions when the task has them, so the worker does
 * not search for what the manager already knows. A task without them, such as
 * one from a plan stored before they existed, gets the text it always did.
 */
export function composeWorkerInstructions(
  task: TaskRecord,
  project: ProjectRecord,
  /** Frozen test files this task may not change; empty for a test-change task. */
  frozenPaths: string[] = [],
): string {
  return JSON.stringify({
    objective: task.objective,
    instructions: task.workerPrompt,
    ...workerHintFields(task),
    ...(task.writesTests ? { testsFirst: TESTS_FIRST } : {}),
    ...(frozenPaths.length ? { frozenTests: frozenNote(frozenPaths) } : {}),
    ...(changesUi(task) ? { uiEvidence: UI_EVIDENCE } : {}),
    acceptanceCriteria: task.acceptanceCriteria,
    verificationCommands: project.policy.verification.commands,
  });
}

export function verificationFailed(verification?: VerificationView): boolean {
  if (!verification) return false;
  return verification.status === "failed" || Boolean(verification.failureCode);
}

/**
 * Manager listing, manager reads and interactive workers share this root.
 * Local folder projects use the live original path (ADR 007). A captured
 * snapshotSha256 (superseded create-time copies / test helper) still uses the
 * review workspace until it is a live folder.
 */
export function projectWorkingRoot(dataRoot: string, project: ProjectRecord): string {
  const workspace = projectFiles(dataRoot, project.id).workspace;
  if (project.source.kind !== "local_folder") return workspace;
  if (project.source.snapshotSha256) return workspace;
  return project.source.originalPath;
}

export function managerReadableRoot(dataRoot: string, project: ProjectRecord): string {
  return projectWorkingRoot(dataRoot, project);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function canDispatchStatus(status: ProjectStatus): boolean {
  return status === "running" || status === "waiting_for_capacity" || status === "reviewing";
}

export function checksPassed(view: VerificationView | undefined, required: string[]): boolean {
  return (
    view?.status === "passed" &&
    !view.failureCode &&
    required.every((command) =>
      view.commands.some(
        (result) => result.command === command && result.exitCode === 0 && !result.error,
      ),
    )
  );
}
