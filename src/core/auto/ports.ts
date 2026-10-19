import type { AutoCase, AutoUsage, FinishStatus } from "@shared/auto-run";
import type { EditGuardEvidence } from "@shared/edit-guard";

export interface CaseAttemptInput {
  case: AutoCase;
  attempt: number;
  /** Same key = continue the same session (repairs, resumes); a new key starts fresh. */
  sessionKey: string;
  /** Whether this attempt starts its session (for the record: the key decides). */
  fresh: boolean;
  /** Why the previous attempt was not accepted, for a repair. */
  repairFindings?: string;
  /** What earlier cases learned, carried forward briefly. */
  learnings: string[];
  worktree: string;
  deadline: Date;
  signal: AbortSignal;
  /** The case's time ran out on verified work: only ask whether it is complete; no file changes. */
  finalize?: boolean;
  /**
   * Run the project's setup again, as at the start (with the network when
   * downloads are approved), after the worker changed its dependencies.
   */
  installDependencies?: (signal: AbortSignal) => Promise<VerificationResult>;
  /**
   * Called when the worker starts (true) and stops (false) waiting for a model
   * other work holds. The case's clock stops meanwhile: a busy model is not the
   * worker's time.
   */
  onCapacityWait?: (waiting: boolean) => void;
}

export interface CaseAttemptResult {
  /** The worker's own announcement. Acceptance is decided by checks and scope. */
  finish: FinishStatus;
  summary?: string;
  blockedReason?: string;
  learnings?: string[];
  error?: string;
  /** Poundlock or the model could not be reached: retried, never counted as a repair. */
  inferenceUnavailable?: boolean;
  /** Poundlock answered that other work holds the model: waited out, never counted. */
  capacityBusy?: boolean;
  usage?: AutoUsage;
  compactions?: number;
  /** What the edit guard answered in this attempt; absent when it saw no edits. */
  editGuard?: EditGuardEvidence;
  /** Commands earlier attempts left running, stopped before this one started. */
  interruptedActions?: string[];
}

export interface AutoWorkerPort {
  runCase(input: CaseAttemptInput): Promise<CaseAttemptResult>;
}

export interface VerificationResult {
  passed: boolean;
  /** `error`: why a command failed although it exited 0, such as running no tests. */
  commands: Array<{ command: string; exitCode: number | null; output: string; error?: string }>;
}

export interface AutoVerifierPort {
  verify(worktree: string, signal: AbortSignal): Promise<VerificationResult>;
}

/** Setup before the base check: run once, in the run's isolation. */
export interface AutoPreparePort {
  prepare(signal: AbortSignal): Promise<VerificationResult>;
}
