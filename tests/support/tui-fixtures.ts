/**
 * Plain values for the terminal client's tests: a project, its tasks and a
 * whole `AppStateView`, built without a store, a host or a terminal.
 */
import type { ToolApproval } from "@shared/permissions";
import type {
  AppStateView,
  AttemptRecord,
  ChatMessage,
  ProjectRecord,
  ProjectSnapshot,
  TaskRecord,
} from "@shared/types";
import { defaultPolicy } from "@shared/types";

const WHEN = "2026-01-01T00:00:00.000Z";

export function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "demo",
    archived: false,
    createdAt: WHEN,
    updatedAt: WHEN,
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: "/tmp/demo",
      capturedAt: WHEN,
      snapshotSha256: "",
      baseRevision: "",
      includedFiles: 1,
      includedBytes: 1,
      excludedPatterns: [],
      includedUncommitted: false,
      originalFingerprint: "",
    },
    policy: defaultPolicy(),
    budget: { jobsSubmitted: 0, managerTurnsUsed: 0, externalEscalationsUsed: 0 },
    integration: {},
    planRevision: 1,
    managerSessionId: "session-1",
    eventCursor: 0,
    ...overrides,
  } as ProjectRecord;
}

export const PATCH = [
  "--- a/src/tokenizer.ts",
  "+++ b/src/tokenizer.ts",
  "@@ -1 +1,2 @@",
  "+export const split = (text: string) => text.split(/\\s+/);",
  "--- a/tests/tokenizer.test.ts",
  "+++ b/tests/tokenizer.test.ts",
  "@@ -1 +1,2 @@",
  '+it("splits", () => {});',
].join("\n");

export function attempt(number: number, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: `a${number}`,
    number,
    idempotencyKey: "k",
    requestHash: "h",
    profileId: "p1",
    profileName: "Qwen3 Coder 30B",
    harnessId: "pi",
    status: "running",
    createdAt: WHEN,
    selectionReason: "",
    execution: "interactive",
    ...overrides,
  } as AttemptRecord;
}

export function task(
  title: string,
  status: TaskRecord["status"],
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id: title.toLowerCase().replace(/\W+/g, "-"),
    title,
    objective: title,
    workerPrompt: title,
    acceptanceCriteria: "",
    dependsOn: [],
    difficulty: "small",
    route: "interactive",
    contextNote: "",
    status,
    repairCount: 0,
    attempts: [],
    ...overrides,
  } as TaskRecord;
}

/** A finished attempt that changed two files and passed its checks. */
export function finishedAttempt(number = 1): AttemptRecord {
  return attempt(number, {
    status: "completed",
    result: {
      status: "completed",
      output: "",
      patches: [{ root: ".", baseRevision: "", patch: PATCH, sha256: "" }],
      verification: { status: "passed", commands: [] },
    },
  });
}

export function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return { project: project(), tasks: [], messages: [], ...overrides };
}

export const ROLES = {
  manager: {
    profileId: "m",
    profileName: "Qwen3.8 27B IQ3_S",
    source: "interactive",
    approvedDataDestination: "operator_network",
  },
  interactive: {
    profileId: "w",
    profileName: "Qwen3 Coder 30B",
    source: "interactive",
    approvedDataDestination: "operator_network",
  },
} as const;

export function state(overrides: Partial<AppStateView> = {}): AppStateView {
  return {
    connection: {
      url: "https://poundlock.example:8443",
      tokenConfigured: true,
      roles: {},
      rolesReady: true,
    },
    probe: { ok: true, version: "0.9.4" } as AppStateView["probe"],
    integrations: {},
    permissions: { defaultMode: "ask" },
    ui: { composerInfolets: [], desktopNotifications: false } as AppStateView["ui"],
    appearance: { theme: "system" },
    projects: [project()],
    selectedProjectId: "proj-1",
    snapshot: snapshot(),
    busy: false,
    ...overrides,
  } as AppStateView;
}

export function message(role: ChatMessage["role"], text: string, id = `${role}-${text.length}`) {
  return { id, role, text, createdAt: WHEN } as ChatMessage;
}

export function approval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    id: "appr-1",
    projectId: "proj-1",
    projectName: "demo",
    planRevision: 1,
    kind: "bash",
    action: "npm test",
    reason: "run the test suite",
    cwd: "/tmp/demo",
    ...overrides,
  };
}
