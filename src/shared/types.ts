import { SECRET_PATHS } from "./secret-paths";

export const APP_NAME = "Poundlock Dispatch";
export const PI_VERSION = "1.1.0";
export const EXAMPLE_CONTROLLER_URL = "http://127.0.0.1:7331";

export const MAX_SNAPSHOT_FILES = 10_000;
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

export type ProjectStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "waiting_for_capacity"
  | "needs_input"
  | "reviewing"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

/** Why Dispatch paused a run. Every paused project carries exactly one. */
export type PauseCause =
  | "user_wait"
  | "dispatch_closed"
  | "undecided_review"
  | "approval_denied"
  | "infrastructure"
  | "capacity"
  | "manager_interrupted"
  | "awaiting_resume"
  /** Three attempts of one task in a row produced nothing usable. */
  | "unusable_attempts";

interface PauseRecord {
  cause: PauseCause;
  detail: string;
  at: string;
}

/** What kind of answer a recorded question needs. */
export type NeedsInputKind =
  | "question"
  | "tool_reconciliation"
  | "environment"
  /**
   * A previously authorized route (worker or manager profile) changed in
   * Poundlock since it was approved: "re-approve the route in Settings →
   * Models and routing before retrying" — see `RouteRevisionChangedError` in
   * `role-routing.ts`.
   */
  | "route_change"
  | "configuration"
  /** The manager asked to use a folder outside the project; see `needsInput.folder`. */
  | "folder_access";

export type TrustedRuntimeKind = "node";

/** A runtime installation the user may explicitly select for a project. */
export interface RuntimeCandidate {
  kind: TrustedRuntimeKind;
  /** Directory containing the executable; this is what a project selects. */
  directory: string;
  version: string;
  source: "nvm";
}

/** The project environment Dispatch actually selected, or why it could not. */
export interface ProjectEnvironmentRecord {
  kind: "python";
  status: "ready" | "blocked";
  /** existing: reused as-is; uv / venv: created or completed by Dispatch. */
  tool?: "existing" | "uv" | "venv";
  /** The venv's own interpreter path, which is how it is invoked. */
  python?: string;
  pythonVersion?: string;
  requirement?: string;
  uv?: string;
  virtualenv?: string;
  lockfile?: boolean;
  detail: string;
  /** Specific recovery instructions when blocked. */
  recovery?: string;
  updatedAt: string;
}

export interface InfrastructureIssue {
  code: "capacity" | "managed_identity" | "model_startup" | "network" | "service";
  title: string;
  detail: string;
  retryAt?: string;
}

export type TaskStatus =
  | "blocked"
  | "ready"
  | "queued"
  | "running"
  | "needs_review"
  | "repairing"
  | "applied"
  | "failed"
  | "cancelled";

type AttemptStatus =
  | "pending_submit"
  | "submitted"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

type ExecutionRoleName =
  | "manager"
  | "interactive"
  /** An attempt from a version that ran Poundlock jobs on its own; kept as history. */
  | "durable"
  | "reviewer"
  | "autocomplete"
  | "escalation";

export type FailureClass =
  | "infrastructure"
  | "environment"
  | "work"
  | "policy"
  | "context_limit"
  | "output_limit"
  | "ambiguous_inference";

export type Difficulty = "small" | "medium" | "large";

export type TaskRoute = "interactive" | "snippet";

export type DataDestination = "unknown" | "operator_network" | "external";
export interface ModelOccupancy {
  kind: "interactive" | "job" | null;
  /**
   * The exclusive runtime slot this profile competes for, `node/runtime`, or
   * null when it has none. Profiles with the same slot run one at a time, and
   * moving between two of them loads a different model. Absent from a
   * controller older than 2026-09-23; see `sameRuntimeSlot`.
   */
  slot?: string | null;
  node_id: string | null;
  runtime_profile: string | null;
}

/**
 * A measured capability name, each named after the Toolkit fixture that
 * produces it rather than the routing decision it informs.
 * `code_repair_verified` is the `coding`
 * workload; `plan_tool_schema` is the `tool_schema` workload; `sealed_investigation`
 * is the sealed, synthetic-catalogue investigation workload (both variants).
 */
export type CapabilityName = "code_repair_verified" | "plan_tool_schema" | "sealed_investigation";

/** Toolkit scoring verdict for one capability, before Dispatch's own staleness/settings checks. */
export type CapabilityMeasurementStatus = "qualified" | "smoke" | "insufficient";

/** Whether the measurement's settings match how the profile is configured now. */
export type CapabilitySettingsMatch = "exact" | "different";

interface CapabilityMeasuredSettings {
  context_tokens?: number;
  max_output_tokens?: number;
  reasoning?: string;
  harness?: string;
}

/**
 * One published capability measurement for a model profile, made from a
 * Poundlock Toolkit summary by Poundlock's `scripts/toolkit-capabilities.py`.
 * `age_days`, `stale`, `settings_match` and `measured_failure` are derived by
 * Poundlock at read time, never stored —
 * Dispatch never re-derives them. See `src/shared/capabilities.ts` for how
 * Dispatch collapses this into a routing-usable status.
 */
export interface CapabilityMeasurement {
  name: CapabilityName;
  status: CapabilityMeasurementStatus;
  passed: number;
  attempted: number;
  source?: string;
  toolkit_version?: string;
  run_ids?: string[];
  identity_sha256?: string;
  result_sha256?: string;
  measured_at?: string;
  measured_settings?: CapabilityMeasuredSettings;
  note?: string;
  recorded_at?: string;
  age_days?: number;
  stale?: boolean;
  settings_match?: CapabilitySettingsMatch;
  /**
   * Derived by Poundlock: every attempt was made and none passed. Distinct
   * from `status: "insufficient"`, which also covers a run whose attempts all
   * passed but whose identity or freshness could not be confirmed.
   */
  measured_failure?: boolean;
}
/** Explicitly configured compatibility; never guessed from names or adapters. */
export interface ProfilePreference {
  approvedDestination?: DataDestination;
}

interface InputChoice {
  id: string;
  label: string;
  /** One line under the label, for a manager question's option. */
  description?: string;
}

/** An answer the manager offers with a question; at most `MAX_QUESTION_OPTIONS`. */
export interface QuestionOption {
  label: string;
  description?: string;
}

export const MAX_QUESTION_OPTIONS = 4;
/** Choice ids for a manager question's options: `option:1`, `option:2`, … */
export const QUESTION_OPTION_PREFIX = "option:";
/** Choice ids for a folder request. */
export const FOLDER_CHOICE = {
  read: "folder:read",
  write: "folder:write",
  deny: "folder:deny",
} as const;

/**
 * A saved task from a version that ran jobs may still say "durable"; it runs
 * interactively, like any task with no route.
 */
export function resolveTaskRoute(task: { route?: TaskRoute; difficulty: Difficulty }): TaskRoute {
  return task.route === "snippet" ? "snippet" : "interactive";
}

/** Where a task runs: every route does its work on this Mac. */
export const TASK_EXECUTION_PLACE =
  "Edits and commands run on this Mac in the attached folder; the model answers through Poundlock. Closing Dispatch stops it.";

export interface LocalManagerSettings {
  enabled: boolean;
  url: string;
  token: string;
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
}

interface LocalManagerPublic extends Omit<LocalManagerSettings, "token"> {
  tokenConfigured: boolean;
}

export interface ConnectionSettings {
  localManager?: LocalManagerSettings;
  escalation?: import("./escalation").EscalationSettings;
  /** The SearXNG instance web search uses; none means no web search anywhere. */
  webSearch?: import("./web-search").WebSearchSettings;
  url: string;
  token: string;
  roles: import("./roles").RoleMap;
  profiles?: Record<string, ProfilePreference>;
}

export interface ConnectionPublic {
  localManager?: LocalManagerPublic;
  escalation?: import("./escalation").EscalationSettings;
  webSearch?: import("./web-search").WebSearchSettings;
  url: string;
  tokenConfigured: boolean;
  roles: import("./roles").RoleMap;
  rolesReady: boolean;
  profiles?: Record<string, ProfilePreference>;
}

interface SourceLimits {
  bytes: number;
  files: number;
}

export interface PoundlockModelProfile {
  model_label?: string | null;
  endpoint_kind?: string;
  data_destination?: DataDestination;
  thinking?: ProfileThinkingDefault;
  busy?: boolean;
  occupancy?: ModelOccupancy;
  routing_revision?: string;
  id: string;
  name: string;
  aliases: string[];
  model_id: string;
  context_tokens: number;
  max_output_tokens: number;
  workload_class: string;
  uses?: string[];
  wake_policy: string;
  last_checked_at?: string | null;
  last_check_ok?: boolean | null;
  last_check_message?: string | null;
  /** Empty/absent means unknown, never a measured failure. */
  capabilities?: CapabilityMeasurement[];
}

interface PoundlockHarnessProfile {
  id: string;
  name: string;
  kind: string;
  version: string;
}

export interface JobOptions {
  role: string;
  permissions: string[];
  models: PoundlockModelProfile[];
  harnesses: PoundlockHarnessProfile[];
  git_hosts: string[];
  outbound_network_allowed: boolean;
  source_limits: SourceLimits;
}

/** A model profile's server-side thinking default, applied by Poundlock itself. */
export type ProfileThinkingDefault = "model_default" | "off";

/** Explicit `reasoning_effort` values Poundlock forwards unchanged. `max` is absent on purpose: LiteLLM sends it upstream as `xhigh`. */
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
/** `model_default` sends nothing, so the profile's and then the model's default apply. `none` is an explicit choice. */
export type ReasoningChoice = "model_default" | ReasoningLevel;

export interface ModelPricing {
  inputPerMtok: number;
  outputPerMtok: number;
  /** Where the price comes from, e.g. litellm_route or openrouter_catalog. An estimate, not a bill. */
  source: string;
  refreshedAt?: string;
}

export interface ModelDisabledState {
  reason: string;
  source: string;
  since: string;
  lastCheck?: string;
}

export interface InteractiveModel {
  modelLabel?: string | null;
  dataDestination?: DataDestination;
  /** The operator's configured default for this profile on Poundlock. */
  thinking?: ProfileThinkingDefault;
  busy?: boolean;
  occupancy?: ModelOccupancy;
  routingRevision?: string;
  id: string;
  name?: string;
  aliases?: string[];
  context_tokens?: number;
  max_output_tokens?: number;
  workload_class?: string;
  uses?: string[];
  profileId?: string;
  upstreamModel?: string;
  wakePolicy?: string;
  endpointKind?: string;
  availability?: string;
  availabilityReason?: string;
  blockedReason?: string;
  warningReason?: string;
  connectionMode?: string;
  managedIdentityStatus?: string;
  /** Empty/absent means unknown, never a measured failure. */
  capabilities?: CapabilityMeasurement[];
  /** Explicit levels Poundlock verified take effect. Empty: offer only the model default. */
  reasoningLevels?: ReasoningLevel[];
  reasoningVerifiedAt?: string;
  /** What answers behind the stable name; display only, never used to route. */
  servedModel?: string;
  provider?: string;
  pricing?: ModelPricing;
  status?: "enabled" | "disabled";
  disabled?: ModelDisabledState;
}

export interface ManagedIdentityUsage {
  endpoint_id: string;
  status: string;
  connection_mode?: string;
  external_authorized?: boolean;
  budget?: {
    max_budget?: number | null;
    budget_duration?: string | null;
    rpm_limit?: number | null;
    tpm_limit?: number | null;
  };
  usage?: {
    spend?: number | null;
    max_budget?: number | null;
    remaining_budget?: number | null;
    budget_duration?: string | null;
    budget_reset_at?: string | null;
    observed_at?: string | null;
    blocked?: boolean | null;
    source?: string | null;
  };
  usage_status?: string;
}

export interface ManagedIdentityUsageResponse {
  managed_identities: ManagedIdentityUsage[];
}

export interface PoundlockCapabilitiesView {
  api_major: number;
  contract_revision: number;
  features: string[];
}

export interface ConnectionProbe {
  managedIdentities?: ManagedIdentityUsage[];
  ok: boolean;
  url: string;
  ready: boolean;
  version?: string;
  permissions: string[];
  missingPermissions: string[];
  durableModels: PoundlockModelProfile[];
  interactiveModels: InteractiveModel[];
  harnesses: PoundlockHarnessProfile[];
  gitHosts: string[];
  outboundNetworkAllowed: boolean;
  error?: string;
  hint?: string;
  capabilities?: PoundlockCapabilitiesView;
}

export type ForgeKind = "github" | "gitea";

interface LocalFolderSource {
  kind: "local_folder";
  originalPath: string;
  capturedAt: string;
  snapshotSha256: string;
  baseRevision: string;
  includedFiles: number;
  includedBytes: number;
  excludedPatterns: string[];
  includedUncommitted: boolean;
  originalFingerprint: string;
  gitRemote?: string;
  forge?: ForgeKind;
}

interface ForgeAccountPublic {
  configured: boolean;
  host: string;
  username: string;
}

export interface IntegrationsPublic {
  github?: ForgeAccountPublic;
  gitea?: ForgeAccountPublic;
}

interface GitProjectSource {
  kind: "git";
  repository: string;
  /** Branch name or 40-character commit, as the user entered it. */
  revision: string;
  capturedAt: string;
  baseRevision: string;
  hasCredentials: boolean;
  forge?: ForgeKind;
}

type ProjectSource = LocalFolderSource | GitProjectSource;

interface VerificationPolicy {
  commands: string[];
  protectedPaths: string[];
}

/**
 * A folder beyond the attached one that this project may use. Read grants name
 * one exact file and bypass the exclusion filter; a root is a directory where
 * the ordinary rules still apply, so secrets stay unreadable inside it.
 */
export interface AccessRoot {
  /** Canonical absolute directory, resolved when granted and re-checked at use. */
  path: string;
  mode: "read" | "write";
  addedAt: string;
  /** Configured up front, or granted in-session by answering a card. */
  grantedBy: "config" | "approval";
  label?: string;
}

export interface ProjectPolicy {
  /** Exact file exceptions granted through the UI, never by manager tool input. */
  readGrants?: string[];
  /** Fix rounds per task for this project; absent uses the app default in Settings. */
  fixRoundsPerTask?: number;
  /**
   * Extra folders this project may read, or write. The attached folder is
   * never listed here; it is always writable.
   */
  roots?: AccessRoot[];
  managerModel: string;
  /**
   * This project's base interactive worker, in place of the app's Worker role.
   * Empty means the app default. The model ladder still applies above it.
   */
  workerModel?: string;
  /**
   * Kept for a saved project that still carries it; no UI writes it, so it is
   * always empty in practice today; it is left in place rather than removed
   * silently. An empty list means every eligible profile is allowed.
   */
  allowedWorkerProfileIds: string[];
  verification: VerificationPolicy;
  /** When omitted, the project uses Settings → Permissions. */
  toolTrust?: import("./permissions").ToolTrustMode;
  toolTrustRevision?: number;
  /** Internet and local network switches (ADR 015); see `projectReach` for defaults. */
  network?: import("./network").ProjectNetwork;
  /** False turns off the mutation check at acceptance (`mutation-check.ts`); absent is on. */
  mutationCheck?: boolean;
  /**
   * Explicitly selected runtime directories (for example an NVM Node `bin`),
   * validated by the main process. Added ahead of the fixed host tool paths.
   */
  runtimes?: { node?: string };
}

interface BudgetState {
  managerTurnsUsed: number;
  jobsSubmitted: number;
  stopReason?: string;
}

interface IntegrationState {
  /** The revision of the review workspace, which only a git project works in. */
  headRevision: string;
  expectedBase: string;
  appliedPatchSha256: string[];
  /** The checks run over every accepted task together, once the last one is accepted. */
  combinedVerification?: VerificationView;
}

export interface ProjectRecord {
  /** This conversation's reasoning choice for manager turns; overrides the Manager role default. */
  reasoningOverride?: ReasoningChoice;
  managerEscalation?: import("./escalation").EscalationGrant;
  escalations?: import("./escalation").EscalationDecision[];
  /**
   * Escalation profiles the owner declined this run. The manager is not
   * offered them again, until the owner mentions escalation in a message.
   */
  declinedEscalations?: string[];
  /**
   * Owner messages sent while the manager was busy, by message id. The next
   * turn leads with them, so a review prompt's clipping cannot hide them.
   */
  unreadOwnerMessages?: string[];
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  source: ProjectSource;
  policy: ProjectPolicy;
  budget: BudgetState;
  integration: IntegrationState;
  goal?: string;
  infrastructureIssue?: InfrastructureIssue;
  needsInput?: {
    question: string;
    askedAt: string;
    choices?: InputChoice[];
    kind?: NeedsInputKind;
    /** For `folder_access`: what the manager asked for, checked when asked and again when granted. */
    folder?: { path: string; mode: "read" | "write"; reason: string };
  };
  /** Present only while status is paused; cleared on every other transition. */
  pause?: PauseRecord;
  /** Last prepared (or blocked) project environment, for status and recovery copy. */
  environment?: ProjectEnvironmentRecord;
  /** Set when removal from Dispatch began; an interrupted removal is finished on restart. */
  removing?: { startedAt: string };
  planRevision: number;
  /** Dispatch-owned workflow identity. Restoring a Pi conversation cannot reuse this to dispatch work. */
  workflowId?: string;
  /** Pi restoration cannot dispatch unless this is true after plan approval or explicit resume. */
  dispatchAuthorized?: boolean;
  managerSessionId: string;
  freshConversation?: boolean;
  eventCursor: number;
}

/**
 * Stable identity a renderer action is bound to. The main process rejects the
 * action if the project was replaced or a new run started since it was chosen.
 */
export interface ProjectActionTarget {
  projectId: string;
  workflowId?: string;
}

/** Result of a main-process export: the renderer never supplies the destination. */
export type ExportOutcome =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "no_changes" }
  | { status: "failed"; error: string };

export interface PendingBoardChange {
  source: "manager" | "user" | "runtime";
  reason: string;
  createdAt: string;
  plan: PlanRecord;
  tasks: TaskRecord[];
  /** What approving would change on the published board, task by task. */
  changes?: import("./board-changes").TaskChange[];
}

/** A test file a later worker may not change, and its content when it was frozen. */
export interface FrozenTest {
  path: string;
  sha256: string;
  /** Title of the accepted task that wrote or last changed it. */
  task: string;
}

/**
 * One thing the owner needs, kept on the plan across revisions: the
 * requirement ledger, so a plan rewrite cannot quietly drop something the
 * owner asked for.
 */
export interface Requirement {
  /** "R1", "R2", …, stable across revisions. */
  id: string;
  /** What the owner needs, in their words. */
  text: string;
  /** How a user would show it works: "after importing a folder, the grid shows every photo". */
  scenarios: string[];
  /** done: every task that cites it is accepted. waived: the owner said to drop it. */
  status: "open" | "done" | "waived";
  /** For done, the accepted tasks that cite it; for waived, the owner's words. */
  evidence?: string;
  /** The round-end verifier's judgement of the accepted work, kept until that work changes. */
  verdict?: {
    result: "shown" | "partly" | "not shown";
    note: string;
    at: string;
    /** From a Planner not qualified to gate the goal (ADR 016, Local tier). */
    advisory?: boolean;
  };
}

/** A question or problem the manager noted during a round, raised with the owner when it ends. */
export interface OwnerIssue {
  text: string;
  requirementId?: string;
  notedAt: string;
  /** Set once the round-end review has put it in front of the manager to raise. */
  raisedAt?: string;
}

/** A slice of the product a user can try, and the requirements it delivers. */
export interface Milestone {
  /** "M1", "M2", … */
  id: string;
  title: string;
  /** What a user can do once it is done. */
  goal: string;
  requirementIds: string[];
}

export interface PlanRecord {
  /** Version of the deterministic manager-proposal compiler. */
  compilerVersion?: number;
  /** Tests frozen by accepted test tasks; kept across plan revisions. */
  frozenTests?: FrozenTest[];
  /** The owner's requirements, kept across plan revisions. */
  requirements?: Requirement[];
  /**
   * The spec's milestones (ADR 016), in order: each a slice a user can try,
   * M1 a walking skeleton. Autopilot plans each one's tasks when it gets there.
   */
  milestones?: Milestone[];
  /** The stack, the layout, and how the UI is tested without a person. */
  architecture?: string;
  /** What the product deliberately leaves out, so no one builds it. */
  scopeOut?: string[];
  /** Questions and problems noted during the run, kept across plan revisions. */
  issues?: OwnerIssue[];
  verificationCommands?: string[];
  allowDependencyDownloads?: boolean;
  environmentNeed?: "none" | "python";
  revision: number;
  summary: string;
  acceptanceCriteria: string[];
  authority: string;
  approved: boolean;
  approvedAt?: string;
  /**
   * Set when Dispatch approved the plan itself, under this tool-trust mode,
   * because it was within the listed permissions and run limits. Absent when
   * the user approved it.
   */
  autoApprovedUnder?: import("./permissions").ToolTrustMode;
  createdAt: string;
}

/**
 * What kind of work a task is, set by the manager on `propose_plan`/
 * `delegate_task`. Optional everywhere it is carried (`ProposePlanInput`,
 * `PlanProposalTask`, `TaskRecord`) so an absent value — every task created
 * before this field existed, and any internal caller that does not set it —
 * reproduces today's routing exactly (`resolveStartingWorkerBinding` in
 * `core/role-routing.ts`). `closed_implementation`: the prompt already closes
 * the search space (a specified change, a known fix). `open_investigation`:
 * deciding what to try, or whether something is possible, is the work itself.
 * `planning`: the deliverable is a structured plan, not code.
 */
export type TaskKind = "closed_implementation" | "open_investigation" | "planning";

export interface TaskRecord {
  /** Small delegated documents and visual artifacts may use manager review without a check. */
  managerReviewOnly?: boolean;
  /** Policy scope selected by Dispatch, not by manager tool input. */
  scope?: "project";
  escalation?: import("./escalation").EscalationGrant;
  id: string;
  title: string;
  objective: string;
  workerPrompt: string;
  acceptanceCriteria: string;
  /** The ledger requirements this task serves. */
  requirementIds?: string[];
  /** The milestone this task belongs to. */
  milestoneId?: string;
  dependsOn: string[];
  difficulty: Difficulty;
  taskKind?: TaskKind;
  route?: TaskRoute;
  /** Background the manager already gathered. Sent to the worker, bounded; see `core/task-hints`. */
  contextNote: string;
  /** Paths or globs the task should change, from the manager. Absent on plans stored before this existed. */
  filesToTouch?: string[];
  /** Existing functions, modules or patterns to use, each with its path. Absent on older plans. */
  reuse?: string[];
  profileId?: string;
  profileName?: string;
  selectionReason?: string;
  status: TaskStatus;
  repairCount: number;
  recoveryCount?: number;
  /** Dispatch already suggested splitting this oversized task after a failure. */
  splitAdvised?: boolean;
  /** This task writes tests; once accepted, its test files are frozen for the plan. */
  writesTests?: boolean;
  /** This task deliberately changes frozen tests; shown on the plan card. */
  changesFrozenTests?: boolean;
  /** The frozen tests it may change, when Autopilot's Planner named them. */
  frozenTestsToChange?: string[];
  /** Why those frozen tests are out of date, in the Planner's words. */
  frozenChangeReason?: string;
  freshWorkerSession?: boolean;
  workerSessionKey?: string;
  /** Set once the fix-round or retry-after-interruption allowance is used up. Cleared by any explicit user decision on the task. */
  stuck?: import("./stuck-task").TaskStuckState;
  /**
   * Internal bookkeeping only, never shown to the user: attempts up to this
   * index are excluded from the separate worker-attempt limit once an
   * explicit user decision (Retry task, a reply while stuck) or an
   * escalation grants a fresh allowance. `repairCount`/`recoveryCount`,
   * which the user does see, are reset to 0 at the same time.
   */
  attempts: AttemptRecord[];
}

export interface AttemptRecord {
  /** The manager's decision that sent this attempt back for another try. */
  review?: {
    decision: "repair" | "recovery" | "retry";
    reason: string;
    at: string;
    nextAttempt: number;
  };
  /** "durable": a Poundlock job run by a version that routed tasks to jobs; kept as history. */
  execution?: "interactive" | "durable";
  /** Frozen tests Dispatch put back after this attempt changed them; its checks ran against the edits. */
  frozenRestored?: string[];
  /** The mutation check at acceptance: each small break tried, and whether a check caught it. */
  mutation?: {
    at: string;
    mutants: Array<{ path: string; line: number; change: string; caught: boolean }>;
  };
  role?: ExecutionRoleName;
  routingRevision?: string;
  dataDestination?: DataDestination;
  piSessionId?: string;
  piMessageId?: string;
  failureClass?: FailureClass;
  submission?: import("./job-contract").SubmitJobInput;
  id: string;
  number: number;
  idempotencyKey: string;
  requestHash: string;
  jobId?: string;
  profileId: string;
  profileName: string;
  harnessId: string;
  status: AttemptStatus;
  createdAt: string;
  submittedAt?: string;
  terminalAt?: string;
  selectionReason: string;
  result?: JobResultView;
  error?: string;
}

export interface JobResultView {
  status: string;
  output: string;
  patches: PatchView[];
  verification?: VerificationView;
  provenance?: Record<string, unknown>;
  cleanup?: Record<string, unknown>;
  /**
   * In-job repairs the durable job performed on itself inside this one
   * Dispatch attempt, before Dispatch ever saw a result — from the job's own
   * `provenance.attempt_count` (1 + repairs the job made on its own).
   * Distinct from `TaskRecord.repairCount`, which counts times Dispatch
   * itself sent the task back for a fresh attempt.
   */
  selfRepairs?: number;
}

export interface PatchView {
  root: string;
  baseRevision: string;
  patch: string;
  sha256: string;
}

export interface VerificationView {
  status: string;
  reason?: string;
  failureCode?: string;
  commands: Array<{
    command: string;
    exitCode?: number | null;
    output: string;
    error?: string | null;
  }>;
  changedProtectedPaths?: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "manager" | "system";
  text: string;
  createdAt: string;
  /** The reasoning setting a manager reply was produced with. */
  reasoning?: ReasoningChoice;
  toolTrace?: Array<{ name: string; summary: string; error?: boolean }>;
  /**
   * A system message the user should not miss, such as a decision Dispatch made
   * for them. Clients show it as a notice, not as muted machinery.
   */
  kind?: "notice";
}

export interface FileEntry {
  path: string;
  bytes: number;
  executable: boolean;
  included: boolean;
  reason?: string;
}

export interface SnapshotPreview {
  root: string;
  files: FileEntry[];
  includedFiles: number;
  includedBytes: number;
  excludedFiles: number;
  truncated: boolean;
  warnings: string[];
}

export interface RunHistoryRecord {
  id: string;
  archivedAt: string;
  plan?: PlanRecord;
  tasks: TaskRecord[];
  messages: ChatMessage[];
}

export interface ProjectSnapshot {
  project: ProjectRecord;
  plan?: PlanRecord;
  tasks: TaskRecord[];
  pendingBoard?: PendingBoardChange;
  messages: ChatMessage[];
  /** The project brief the manager keeps pinned in its context, for the owner to read. Absent when there is none. */
  brief?: string;
  selectedTaskId?: string;
}

export interface RecoveryNotice {
  kind:
    | "unresolved_tool"
    | "ambiguous_inference"
    | "route_change"
    | "token_change"
    | "concurrent_edit"
    | "interrupted_command";
  title: string;
  detail: string;
  nextAction: string;
}

export interface LiveWorkEntry {
  at: string;
  text: string;
}

export interface AppStateView {
  approvals?: import("./permissions").ToolApproval[];
  recovery?: RecoveryNotice[];
  connection: ConnectionPublic;
  probe?: ConnectionProbe;
  managerSelection?: {
    projectId: string;
    name: string;
    origin: "default" | "project" | "escalation" | "local";
  };
  discovery?: { refreshing: boolean; updatedAt?: string };
  integrations: IntegrationsPublic;
  permissions: import("./permissions").PermissionSettings;
  projects: ProjectRecord[];
  selectedProjectId?: string;
  snapshot?: ProjectSnapshot;
  busy: boolean;
  /**
   * The selected project's manager is mid-turn: a message can still be sent,
   * and opens its next turn.
   */
  managerTurning?: boolean;
  activity?: string;
  /**
   * What the manager has said so far in a turn that has not ended yet, for the
   * selected project only.
   *
   * `activity` answers "is anything happening"; it cannot answer "what is it
   * saying", so a turn that takes a minute showed one unchanging line the whole
   * time. The text arrives as `text_delta` events the clients already
   * subscribed to and discarded. It is coalesced before it reaches this
   * snapshot — see `DRAFT_COALESCE_MS` — because every emission re-reads the
   * store.
   *
   * Cleared when the turn ends. The finished message arrives in `snapshot`
   * through the normal path, so a client that ignores this field loses nothing
   * but the wait.
   */
  managerDraft?: string;
  /** The selected project's newest Autopilot run (ADR 016), when it has one. */
  autopilot?: import("./auto-run").AutopilotView;
  /** Projects an Autopilot run is building or was interrupted on, for the project list. */
  autopilotProjects?: Record<string, "building" | "interrupted">;
  /** Autopilot can start here: the app knows where runs live and how to start one. */
  autopilotAvailable?: boolean;
  /**
   * How full the selected project's manager conversation is, as the manager
   * last reported it: after a turn, or after a compaction. Absent until the
   * manager has answered in this session, and after a new conversation starts.
   * It drives the context chip and the offer to compact.
   */
  contextUsage?: import("./compaction").ContextUsage;
  /**
   * Set when this client is watching the selected project rather than driving
   * it, because another client holds its folder. Absent means this client
   * drives — which is the normal case, including when another client is busy
   * with a *different* project.
   *
   * Reading is never fenced, so this is a mode, not an error: the transcript,
   * plan and board are all live. Only starting work is withheld.
   */
  watching?: { heldBy?: string; pid?: number };
  liveWork?: LiveWorkEntry[];
  notice?: { kind: "info" | "error"; text: string };
  ui: import("./ui-preferences").UiPreferences;
  appearance: import("./appearance").AppearanceSettings;
}

/** What the Dispatch app needs: its own work runs through inference only. */
export const REQUIRED_PERMISSIONS = ["models:read", "inference:invoke"] as const;

/** What the terminal client's jobs commands need on top. */
export const JOB_PERMISSIONS = ["jobs:read", "jobs:submit", "jobs:cancel"] as const;

type KnownPermission = (typeof REQUIRED_PERMISSIONS)[number] | (typeof JOB_PERMISSIONS)[number];

/** Poundlock Access checkbox labels for the API permission codes. */
const PERMISSION_LABELS: Record<KnownPermission, string> = {
  "models:read": "List available models",
  "inference:invoke": "Send inference requests",
  "jobs:read": "Read its own jobs and results",
  "jobs:submit": "Submit jobs with supplied files",
  "jobs:cancel": "Cancel its own jobs",
};

const OPTIONAL_PERMISSION_LABELS: Record<string, string> = {
  "external:invoke": "Call external providers",
};

export function permissionLabel(permission: string): string {
  if (permission in PERMISSION_LABELS) {
    return PERMISSION_LABELS[permission as KnownPermission];
  }
  return OPTIONAL_PERMISSION_LABELS[permission] ?? permission;
}

/**
 * Never uploaded, read for a manager, or shown to a sandboxed command, whatever a
 * project's own `.gitignore` says or leaves out. It is the floor under every
 * snapshot, so a missing credential name here sends a secret to the controller:
 * `tests/snapshot-secrets.test.ts` pins it. `runtime/sandbox-policy.ts` keeps a
 * parallel list for the sandbox; a credential name added here belongs there too.
 */
export const DEFAULT_EXCLUSIONS = [
  ".git/",
  "**/.git/**",
  "node_modules/",
  "**/node_modules/**",
  "dist/",
  "build/",
  "target/",
  // SwiftPM's build output: a Swift shell's first build counted 2,618 files as changed.
  ".build/",
  // UI snapshots tests write for the owner; kept with the attempt, not tracked as changes.
  ".dispatch/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".DS_Store",
  ...SECRET_PATHS,
];

export function defaultPolicy(): ProjectPolicy {
  return {
    managerModel: "",
    allowedWorkerProfileIds: [],
    verification: { commands: [], protectedPaths: [] },
  };
}

export function defaultBudget(): BudgetState {
  return { managerTurnsUsed: 0, jobsSubmitted: 0 };
}

export function statusLabel(status: ProjectStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "planning":
      return "Planning";
    case "awaiting_approval":
      return "Review the plan";
    case "running":
      return "Running";
    case "waiting_for_capacity":
      return "Waiting for infrastructure";
    case "needs_input":
      return "Needs your answer";
    case "reviewing":
      return "Reviewing results";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}
