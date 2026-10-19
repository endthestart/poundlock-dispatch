import type { CompactionSummary } from "@shared/compaction";
import type { EditGuardEvidence } from "@shared/edit-guard";
import type { ToolTrustMode } from "@shared/permissions";
import type { InteractiveModel, ProjectRecord, TaskRecord, VerificationView } from "@shared/types";
import type { ApprovalBroker } from "./approval-broker";

export interface WorkerContext {
  project: ProjectRecord;
  task: TaskRecord;
  cwd: string;
  projectRoot?: string;
  model: InteractiveModel;
  /** Resolved by `resolveReasoning`; absent means Model default. */
  reasoning?: import("@shared/types").ReasoningChoice;
  controllerUrl: string;
  token: string;
  dataDir: string;
  trust: ToolTrustMode;
  sessionDir?: string;
  privateHome?: string;
  getPolicy?: () => Promise<{
    project: ProjectRecord;
    permissions: import("@shared/permissions").PermissionSettings;
  }>;
  reviewAction?: (
    request: import("./permission-review").ReviewRequest,
    signal: AbortSignal,
  ) => Promise<import("./permission-review").ReviewDecision>;
  allowDependencyDownloads: boolean;
  /** Frozen test files (project-relative) this worker may read and run but never change. */
  frozenPaths?: string[];
  extraPath?: string[];
  lastApprovedRoutingRevision?: string;
  capabilities?: import("./capabilities").PoundlockCapabilities;
  environmentNeed?: "none" | "python";
  onCapacityWait?: (state: import("./capacity-retry").CapacityWaitState) => void | Promise<void>;
  signal: AbortSignal;
  /**
   * An investigation: no write tools, no environment preparation, no checks,
   * and commands only inside a sandbox that cannot write the project.
   */
  readOnly?: boolean;
  approvals: ApprovalBroker;
  onActivity?: (message: string) => void;
}
export type { EditGuardEvidence };

export interface WorkerResult {
  output: string;
  verification: VerificationView;
  changedFiles: string[];
  patch: string;
  error?: string;
  editGuard?: EditGuardEvidence;
  /** Times the worker's own context was compacted during this attempt. */
  compactions?: CompactionSummary[];
  /** UI snapshots the attempt's tests wrote, kept in the attempt's folder. */
  snapshots?: string[];
}
export interface WorkerPort {
  run(context: WorkerContext): Promise<WorkerResult>;
  verify?(context: WorkerContext): Promise<VerificationView>;
}
