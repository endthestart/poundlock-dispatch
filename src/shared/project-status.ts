import { isTurnBudgetStop } from "./policy-limits";
import { stuckCategoryLabel } from "./stuck-task";
import type {
  AttemptRecord,
  ConnectionPublic,
  PlanRecord,
  ProjectRecord,
  ProjectSnapshot,
  ProjectStatus,
  TaskRecord,
  TaskStatus,
} from "./types";
import { resolveTaskRoute } from "./types";

const LEGACY_LOOP_STOP = /repair budget exhausted|recovery budget exhausted/i;

/** The same plain next steps for every stuck task; no internal budget terms. */
const STUCK_NEXT_STEPS = (title: string) =>
  `Its edits are kept but not accepted. Retry task runs “${title}” again with a fresh set of attempts. Or tell the manager what to change so it can revise the plan, or use Project → Start a new run.`;

/** Plain wording for a stop recorded by an older build, with the last real issue. */
function legacyStopSentence(reason: string, task: TaskRecord): string {
  const last = task.attempts.at(-1);
  const failedCheck = last?.result?.verification?.commands?.find(
    (command) => command.error || (command.exitCode ?? 0) !== 0,
  );
  const issue = last?.error
    ? ` The last attempt ended with: ${last.error}`
    : failedCheck
      ? ` The last check, ${failedCheck.command}, failed (exit ${failedCheck.exitCode ?? "unknown"}).`
      : "";
  const why = /recovery budget/i.test(reason)
    ? "stopped after it was interrupted too many times."
    : "used all its fix rounds without passing review.";
  return `“${task.title}” ${why}${issue}`;
}

/** A task whose worker is actively doing something right now. */
export const IN_FLIGHT: TaskStatus[] = ["running", "queued", "repairing"];

/** In flight, or finished and awaiting the manager's review — the Inspector's "still moving" set. */
export const IN_FLIGHT_OR_REVIEW: TaskStatus[] = [...IN_FLIGHT, "needs_review"];

/**
 * A worker process that has not ended. An interactive attempt that ended
 * ambiguously (for example a terminated stream) is finished evidence awaiting
 * review, not live work: treating it as live would block the review that
 * decides its recovery.
 */
export function isLiveAttempt(attempt: Pick<AttemptRecord, "status">): boolean {
  return attempt.status === "running";
}

function listEnglish(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function taskPhrase(indexes: number[], total: number): string {
  if (indexes.length === 1) return `Task ${indexes[0]} of ${total}`;
  return `Tasks ${listEnglish(indexes.map(String))} of ${total}`;
}

function indexesWhere(
  tasks: { status: TaskStatus }[],
  match: (status: TaskStatus) => boolean,
): number[] {
  return tasks.flatMap((task, index) => (match(task.status) ? [index + 1] : []));
}

function clause(indexes: number[], total: number, one: string, many = one): string | undefined {
  if (!indexes.length) return undefined;
  const verb = indexes.length === 1 ? one : many;
  return `${taskPhrase(indexes, total)} ${verb}.`;
}

function acceptedLine(accepted: number, total: number): string | undefined {
  if (accepted === 0) return undefined;
  if (accepted === total)
    return total === 1 ? "The task was accepted." : `All ${total} tasks accepted.`;
  return `${accepted} of ${total} tasks accepted.`;
}

export function planProgressEvidence(tasks: { status: TaskStatus }[]): string {
  if (!tasks.length) return "No worker tasks have been started.";
  const total = tasks.length;
  const accepted = acceptedLine(tasks.filter((task) => task.status === "applied").length, total);
  const current =
    clause(
      indexesWhere(tasks, (status) => IN_FLIGHT.includes(status)),
      total,
      "started",
    ) ??
    clause(
      indexesWhere(tasks, (status) => status === "needs_review"),
      total,
      "is in review",
      "are in review",
    ) ??
    clause(
      indexesWhere(tasks, (status) => status === "failed"),
      total,
      "failed",
    ) ??
    clause(
      indexesWhere(tasks, (status) => status === "ready"),
      total,
      "is next",
      "are next",
    );
  if (accepted && current) return `${accepted} ${current}`;
  if (accepted) return accepted;
  if (current) return current;
  return total === 1
    ? "1 task on the board. None started."
    : `${total} tasks on the board. None started.`;
}

export function taskExecutionView(
  task: Pick<TaskRecord, "route" | "difficulty">,
  connection: Pick<ConnectionPublic, "roles">,
): { title: string; detail: string } {
  if (resolveTaskRoute(task) === "snippet") {
    const profile = connection.roles.snippet?.profileName ?? "not configured";
    return {
      title: `Snippet — ${profile}`,
      detail: "Uses the snippet/FIM role for a tiny completion.",
    };
  }
  const profile = connection.roles.interactive?.profileName ?? "not configured";
  return {
    title: `Interactive — ${profile}`,
    detail: "Edits the active project workspace locally. Source is not uploaded.",
  };
}

/**
 * The single reason a project is where it is. Dispatch derives every status
 * title, control and next action from this; the renderer must not re-derive.
 */
type WorkflowCause =
  | "discussion"
  | "manager_responding"
  | "plan_approval"
  | "ready_to_start"
  | "running"
  | "reviewing"
  | "tool_approval"
  | "question"
  | "decision"
  | "undecided_review"
  | "environment"
  | "capacity"
  | "infrastructure"
  | "interrupted_inference"
  | "manager_needs_message"
  | "approval_denied"
  | "unusable_attempts"
  | "tool_reconciliation"
  | "configuration"
  | "route_change"
  | "paused"
  | "stuck_task"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Every id maps to one existing control: approve → approvePlan, resume →
 * startRun, pause/wait → pauseRun, cancel → cancelRun,
 * choose → replyInput(choiceId), review_again → reopenRun, override →
 * overrideRun, reply/send_message → the composer, decide_approval → the
 * approval card, retry_task → retryTask(taskId).
 */
export type NextActionId =
  | "approve"
  | "wait"
  | "resume"
  | "pause"
  | "cancel"
  | "choose"
  | "reply"
  | "send_message"
  | "decide_approval"
  | "review_again"
  | "override"
  | "retry_task";

export interface NextAction {
  id: NextActionId;
  label: string;
  primary?: boolean;
  /** For `choose`: the choice id to send through replyInput. */
  choiceId?: string;
  /** For `retry_task`: which task to give a fresh allowance. */
  taskId?: string;
}

/** A host control a next action calls. Names match `DispatchHost`'s methods. */
export type HostControl =
  | { control: "approvePlan" | "startRun" | "pauseRun" | "cancelRun" | "reopenRun" }
  | { control: "overrideRun"; needsReason: true }
  | { control: "retryTask"; taskId: string }
  | { control: "replyInput"; choiceId: string };

/**
 * How a next action is carried out: the host control it calls, or the surface
 * that takes it. This is the contract on `NextActionId` as data, so every
 * front end maps an id the same way instead of keeping its own table.
 */
export type ActionControl = HostControl | { control: "composer" } | { control: "approval_card" };

export function actionControl(action: NextAction): ActionControl | undefined {
  switch (action.id) {
    case "approve":
      return { control: "approvePlan" };
    case "resume":
      return { control: "startRun" };
    case "pause":
    case "wait":
      return { control: "pauseRun" };
    case "cancel":
      return { control: "cancelRun" };
    case "review_again":
      return { control: "reopenRun" };
    case "override":
      return { control: "overrideRun", needsReason: true };
    case "retry_task":
      return action.taskId ? { control: "retryTask", taskId: action.taskId } : undefined;
    case "choose":
      return action.choiceId ? { control: "replyInput", choiceId: action.choiceId } : undefined;
    case "reply":
    case "send_message":
      return { control: "composer" };
    case "decide_approval":
      return { control: "approval_card" };
  }
}

export interface ProjectStatusView {
  cause: WorkflowCause;
  title: string;
  next: string;
  evidence: string;
  active: boolean;
  actions: NextAction[];
  canApprove: boolean;
  canResume: boolean;
  canReopen: boolean;
  canPause: boolean;
  canCancel: boolean;
  canOverride: boolean;
  /** Composer copy for the current state; sending never approves or resumes. */
  composerPlaceholder: string;
}

const ACTIVE_STATUSES = ["running", "reviewing", "waiting_for_capacity", "planning"];

/**
 * The one rule for whether a recorded run stop makes Resume impossible; the
 * orchestrator's start() applies the same rule. Only the manager-turn cap can
 * be resumed through. Approving a revised plan resets the budget and clears
 * the stop.
 */
export function runStopBlocksResume(project: { budget: { stopReason?: string } }): boolean {
  const reason = project.budget.stopReason;
  return Boolean(reason && !isTurnBudgetStop(reason));
}

function interruptedInference(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.filter((task) => {
    const last = task.attempts.at(-1);
    return (
      task.status === "needs_review" &&
      last?.execution === "interactive" &&
      (last.failureClass === "ambiguous_inference" || last.status === "uncertain")
    );
  });
}

interface Derived {
  cause: WorkflowCause;
  title: string;
  next: string;
}

function stuckTaskView(task: TaskRecord): Derived {
  const stuck = task.stuck!;
  return {
    cause: "stuck_task",
    title: "A task needs your direction",
    next: `${stuckCategoryLabel(stuck.category)}: ${stuck.reason} ${STUCK_NEXT_STEPS(task.title)}`,
  };
}

function pausedView(snapshot: ProjectSnapshot, approved: boolean): Derived {
  const { project, tasks } = snapshot;
  const pause = project.pause;
  const inReview = indexesWhere(tasks, (status) => status === "needs_review");
  const interrupted = interruptedInference(tasks);
  const stuckTask = tasks.find((task) => task.stuck);
  if (stuckTask && (pause?.cause === "undecided_review" || !pause)) return stuckTaskView(stuckTask);
  if (isTurnBudgetStop(project.budget.stopReason))
    return {
      cause: "paused",
      title: "Manager turn limit reached",
      next: "The manager used the turns this run allows. Results are kept. Resume continues with a fresh allowance.",
    };
  if (pause?.cause === "manager_interrupted") {
    return approved
      ? {
          cause: "interrupted_inference",
          title: "Manager response was interrupted",
          next: "Dispatch restarted the manager session from its saved conversation and task state. Files, attempts and approvals are kept. Resume continues the approved work.",
        }
      : {
          cause: "manager_needs_message",
          title: "Manager needs another message",
          next: "The manager's reply ended before it finished. Dispatch started a fresh manager session from the saved conversation. Send another message to continue.",
        };
  }
  if (interrupted.length) {
    return {
      cause: "interrupted_inference",
      title: "Worker response was interrupted",
      next: `${taskPhrase(
        interrupted.map((task) => tasks.indexOf(task) + 1),
        tasks.length,
      )} ended before the worker finished. Its file changes are kept. Resume sends the retained result to the Project Manager, which can start a fresh worker session without using the repair budget.`,
    };
  }
  if (pause?.cause === "undecided_review" || (inReview.length && !pause)) {
    if (inReview.length)
      return {
        cause: "undecided_review",
        title: "Review needs a decision",
        next: `${taskPhrase(inReview, tasks.length)} ${inReview.length === 1 ? "is" : "are"} still in review. Resume sends that result to the Project Manager again. Reply in the composer if you want to give guidance first.`,
      };
  }
  if (pause?.cause === "approval_denied")
    return {
      cause: "approval_denied",
      title: "Stopped after a declined action",
      next: `${pause.detail} Nothing continues until you resume. Reply in the composer to change the approach first.`,
    };
  if (pause?.cause === "unusable_attempts")
    return {
      cause: "unusable_attempts",
      title: "A task keeps failing without a result",
      next: `${pause.detail} Something is likely wrong with the model, its server or the task. Resume tries again; Retry task starts it fresh.`,
    };
  if (pause?.cause === "capacity" || pause?.cause === "infrastructure")
    return {
      cause: pause.cause,
      title: project.infrastructureIssue?.title ?? "Poundlock needs attention",
      next: `${project.infrastructureIssue?.detail ?? pause.detail} Resume after the listed issue is resolved.`,
    };
  if (pause?.cause === "dispatch_closed")
    return {
      cause: "paused",
      title: "Paused when Dispatch closed",
      next: "Check the folder first — files and models may have changed while Dispatch was closed.",
    };
  return {
    cause: "paused",
    title: "Waiting for your follow-up",
    next: "No new work will start until you resume. Check the folder first if Dispatch was closed — files and models may have changed.",
  };
}

function needsInputView(snapshot: ProjectSnapshot): Derived | undefined {
  const input = snapshot.project.needsInput;
  if (!input) return undefined;
  const stuckTask = snapshot.tasks.find((task) => task.stuck);
  // A manager question's options are answers, not Dispatch's own decision card.
  const decision = Boolean(input.choices?.length) && input.kind !== "question";
  if (stuckTask && !decision) {
    const view = stuckTaskView(stuckTask);
    return { ...view, next: `${view.next} The manager also asked: ${input.question}` };
  }
  if (decision && input.kind === "folder_access")
    return {
      cause: "decision",
      title: "The manager asks to use a folder",
      next: `${input.folder?.mode === "write" ? "Allow it read-only, allow read and write, or refuse." : "Allow it read-only, or refuse."} Nothing outside the project is used until you choose.`,
    };
  if (decision)
    return {
      cause: "decision",
      title: "Needs your decision",
      next: "Choose an action on the card in the conversation. No choice has been made for you.",
    };
  const kind =
    input.kind ??
    (input.question.startsWith("environment_blocked") ? "environment" : undefined) ??
    "question";
  switch (kind) {
    case "tool_reconciliation":
      return {
        cause: "tool_reconciliation",
        title: "An interrupted action needs review",
        next: "A local action was interrupted and its outcome is unknown. Review the retained project changes, then Resume to acknowledge and continue. Dispatch will not replay it.",
      };
    case "environment":
      return {
        cause: "environment",
        title: "Project environment needs attention",
        next: `${input.question.replace(/^environment_blocked:\s*/, "")} Resume retries environment setup.`,
      };
    case "configuration":
      return {
        cause: "configuration",
        title: "Settings need attention",
        next: `${input.question} Resume after changing the setting.`,
      };
    case "route_change":
      return {
        cause: "route_change",
        title: "Profile route changed",
        next: `${input.question} Open Settings → Models and routing, choose the role that uses this profile, and select Approve current route. Then resume.`,
      };
    default:
      return {
        cause: "question",
        title: "Manager asked a question",
        next: "Reply in the message box. Your answer goes to the Project Manager; it does not resume or approve work.",
      };
  }
}

/**
 * The one authoritative derivation of project status, controls and next
 * actions. Pass the pending approvals so an open approval card wins over
 * every other control.
 */
export function projectStatusView(
  snapshot: ProjectSnapshot,
  context?: { approvals?: Array<{ projectId?: string }> },
): ProjectStatusView {
  const { project, plan, tasks, pendingBoard } = snapshot;
  const proposal = pendingBoard?.plan ?? plan;
  const accepted = tasks.filter((task) => task.status === "applied").length;
  const evidence = planProgressEvidence(tasks);
  const active = ACTIVE_STATUSES.includes(project.status);
  const approved = Boolean(plan?.approved);
  const approvalPending = (context?.approvals ?? []).some((item) => item.projectId === project.id);
  const proposalWaiting = Boolean(pendingBoard || (proposal && !proposal.approved));

  let derived: Derived;
  if (approvalPending) {
    derived = {
      cause: "tool_approval",
      title: "Approval needed",
      next: "Decide the approval card in the conversation. Sending a message does not allow the action.",
    };
  } else if (project.status === "completed") {
    derived = {
      cause: "completed",
      title: "Work completed",
      next: "The manager accepted the results. Review the task details and test the project.",
    };
  } else if (project.status === "cancelled") {
    derived = {
      cause: "cancelled",
      title: "Run cancelled",
      next: "Results are retained. You can discuss a revised plan.",
    };
  } else if (
    runStopBlocksResume(project) &&
    ["paused", "needs_input", "awaiting_approval"].includes(project.status) &&
    !proposalWaiting
  ) {
    // A stop recorded before a pause (for example Dispatch closing after a
    // budget ran out) still blocks Resume; say so instead of offering it.
    // A pre-Phase-1 project stuck at a "budget exhausted" dead end (a failed
    // task and that recorded stop) is rescued the same way a newly stuck task
    // is: Retry task, not a prose dead end.
    const legacyStuckTask = LEGACY_LOOP_STOP.test(project.budget.stopReason ?? "")
      ? tasks.find((task) => task.status === "failed")
      : undefined;
    derived = legacyStuckTask
      ? {
          cause: "stuck_task",
          title: "A task needs your direction",
          next: `${legacyStopSentence(project.budget.stopReason ?? "", legacyStuckTask)} ${STUCK_NEXT_STEPS(legacyStuckTask.title)}`,
        }
      : {
          cause: "failed",
          title: "Work stopped",
          next: `${project.budget.stopReason} Tell the manager how to proceed so it can propose a revised plan to approve, or use Project → Start a new run.`,
        };
  } else if (project.status === "failed") {
    derived = {
      cause: "failed",
      title: "Work stopped",
      next:
        project.budget.stopReason || "Discuss the failure with the manager before another attempt.",
    };
  } else if (
    project.infrastructureIssue &&
    ["waiting_for_capacity", "paused", "needs_input"].includes(project.status)
  ) {
    derived = {
      cause: project.infrastructureIssue.code === "capacity" ? "capacity" : "infrastructure",
      title: project.infrastructureIssue.title,
      next:
        project.status === "waiting_for_capacity"
          ? `${project.infrastructureIssue.detail} Dispatch checks again automatically; you can pause while it recovers.`
          : `${project.infrastructureIssue.detail} Resume after the listed issue is resolved.`,
    };
  } else if (project.status === "paused") {
    derived = pausedView(snapshot, approved);
  } else if (project.needsInput) {
    derived = needsInputView(snapshot)!;
  } else if (proposalWaiting) {
    derived = {
      cause: "plan_approval",
      title: "Ready for your approval",
      next: pendingBoard
        ? "The inspector keeps the published list. Approve applies this proposed update, then starts within the listed permissions and limits."
        : "Review the proposal in the main conversation. Approve and start begins work within the listed permissions and limits.",
    };
  } else if (project.status === "planning") {
    derived = {
      cause: "manager_responding",
      title: "Manager is responding",
      next: "The reply appears in the conversation.",
    };
  } else if (project.status === "reviewing") {
    derived = {
      cause: "reviewing",
      title: "Manager is reviewing",
      next: "The manager accepts, repairs, or asks you about each result.",
    };
  } else if (project.status === "waiting_for_capacity") {
    derived = {
      cause: "capacity",
      title: "Waiting for infrastructure",
      next: "Dispatch is waiting for Poundlock or a selected model. You can pause while it recovers.",
    };
  } else if (project.status === "running") {
    derived = {
      cause: "running",
      title: "Work in progress",
      next: "Progress and results appear under each task.",
    };
  } else if (approved) {
    derived = {
      cause: "ready_to_start",
      title: "Approved work is ready",
      next: "Resume the approved work when you are ready.",
    };
  } else {
    derived = {
      cause: "discussion",
      title: "Ready to discuss",
      next: "Ask a question, agree a small action, or ask the manager for a plan.",
    };
  }

  const stuckTaskId =
    derived.cause === "stuck_task"
      ? (tasks.find((task) => task.stuck)?.id ??
        (LEGACY_LOOP_STOP.test(project.budget.stopReason ?? "")
          ? tasks.find((task) => task.status === "failed")?.id
          : undefined))
      : undefined;
  const canApprove =
    !approvalPending &&
    proposalWaiting &&
    !active &&
    !project.needsInput &&
    !["cancelled", "completed", "failed"].includes(project.status);
  const resumableFailure = !runStopBlocksResume(project);
  const canResume =
    !approvalPending &&
    approved &&
    !pendingBoard &&
    resumableFailure &&
    derived.cause !== "manager_needs_message" &&
    ["paused", "awaiting_approval", "needs_input", "failed"].includes(project.status);
  const canReopen = !approvalPending && project.status === "completed" && accepted > 0;
  const canPause = active;
  const canCancel = Boolean(
    (plan || tasks.length) && project.status !== "completed" && project.status !== "cancelled",
  );
  // A stuck task needs Retry task; an override there only cleared the card (12 Oct).
  const canOverride =
    !stuckTaskId &&
    !approvalPending &&
    ["paused", "needs_input"].includes(project.status) &&
    approved &&
    !runStopBlocksResume(project);

  const actions: NextAction[] = [];
  if (approvalPending)
    actions.push({ id: "decide_approval", label: "Decide the approval", primary: true });
  if (derived.cause === "decision")
    for (const choice of project.needsInput?.choices ?? [])
      actions.push({ id: "choose", label: choice.label, choiceId: choice.id, primary: true });
  if (canApprove) {
    actions.push({ id: "approve", label: "Approve and start", primary: true });
    if (project.status !== "paused") actions.push({ id: "wait", label: "Wait" });
  }
  if (canResume) actions.push({ id: "resume", label: "Resume", primary: !actions.length });
  if (canReopen) actions.push({ id: "review_again", label: "Review completed work again" });
  if (stuckTaskId)
    actions.push({ id: "retry_task", label: "Retry task", primary: true, taskId: stuckTaskId });
  if (derived.cause === "question")
    actions.push({ id: "reply", label: "Reply to the manager", primary: !canResume });
  else if (!approvalPending && !active && derived.cause !== "decision")
    actions.push({
      id: "send_message",
      label:
        derived.cause === "stuck_task"
          ? "Ask the manager to revise the plan"
          : "Message the manager",
      primary: !actions.some((action) => action.primary),
    });
  if (canPause) actions.push({ id: "pause", label: "Pause" });
  if (canOverride) actions.push({ id: "override", label: "Override" });
  if (canCancel) actions.push({ id: "cancel", label: "Cancel run" });

  return {
    ...derived,
    evidence,
    active,
    actions,
    canApprove,
    canResume,
    canReopen,
    canPause,
    canCancel,
    canOverride,
    composerPlaceholder:
      derived.cause === "question"
        ? "Reply to the Project Manager’s question…"
        : "Ask the Project Manager, discuss an action, or describe work…",
  };
}

/**
 * The environment line for a plan or project: the environment Dispatch actually
 * selected once prepared, its specific recovery when blocked, and otherwise
 * what it will do. Replaces the old fixed "Python via uv" wording.
 */
export function environmentView(
  plan: Pick<PlanRecord, "environmentNeed" | "allowDependencyDownloads"> | undefined,
  project: Pick<ProjectRecord, "environment" | "policy">,
): { title: string; detail: string; recovery?: string } {
  const node = project.policy.runtimes?.node;
  const nodeLine = node ? ` Node: selected runtime in ${node}.` : "";
  const record = project.environment;
  if (record?.status === "blocked")
    return {
      title: "Python environment blocked",
      detail: `${record.detail}${nodeLine}`,
      recovery: record.recovery,
    };
  if (record?.status === "ready")
    return { title: "Python environment ready", detail: `${record.detail}${nodeLine}` };
  if (plan?.environmentNeed === "python")
    return {
      title: "Python environment prepared before the first local task",
      detail: `An existing compatible .venv is reused; otherwise uv creates .venv, or the installed Python's venv module when uv is not installed and the project does not require it. Declared Python versions and uv.lock are honored; no Python runtime is downloaded.${nodeLine}`,
    };
  return {
    title: "No named environment requested",
    detail: `Workers use the project's own toolchain from trusted tool directories.${nodeLine}`,
  };
}

/** Project lifecycle actions for the Project menu. Ids match the renderer's menu ids. */
export type LifecycleActionId = "newConversation" | "newRun" | "archive" | "unarchive" | "remove";

interface LifecycleActionView {
  id: LifecycleActionId;
  label: string;
  /** Show the action only when available; `reason` explains why it is not. */
  available: boolean;
  reason?: string;
  destructive: boolean;
  /** What the action keeps and what it changes, for the confirmation dialog. */
  consequence: string;
}

const LIFECYCLE_ACTIVE: ProjectStatus[] = [
  "planning",
  "reviewing",
  "running",
  "waiting_for_capacity",
];

/**
 * Why lifecycle actions are unavailable right now, or undefined. The main
 * process enforces the same rule (plus its in-memory activity) before acting,
 * so a stale renderer cannot bypass it.
 */
export function lifecycleBlocker(input: {
  snapshot: ProjectSnapshot;
  approvals?: Array<{ projectId?: string }>;
  busy?: boolean;
}): string | undefined {
  const { project, tasks } = input.snapshot;
  if (input.busy) return "Wait for the current action to finish.";
  if (project.status === "planning") return "Wait for the Project Manager to finish responding.";
  if (LIFECYCLE_ACTIVE.includes(project.status)) return "Pause or cancel the current run first.";
  if ((input.approvals ?? []).some((item) => item.projectId === project.id))
    return "Decide the pending approval in the conversation first.";
  if (project.needsInput?.kind === "tool_reconciliation")
    return "An interrupted action needs review first. Resume to acknowledge it.";
  if (tasks.some((task) => task.attempts.some(isLiveAttempt)))
    return "A worker is still running. Dispatch keeps its record until it ends.";
  return undefined;
}

/** Which lifecycle actions are valid for this snapshot, with the same guard the main process applies. */
export function projectLifecycleActions(input: {
  snapshot: ProjectSnapshot;
  approvals?: Array<{ projectId?: string }>;
  busy?: boolean;
}): LifecycleActionView[] {
  const { snapshot } = input;
  const { project } = snapshot;
  const blocked = lifecycleBlocker(input);
  const hasRun = Boolean(snapshot.plan || snapshot.tasks.length || snapshot.pendingBoard);
  const hasConversation = Boolean(snapshot.messages.length || hasRun);
  const gate = (applies: boolean, empty: string) =>
    blocked
      ? { available: false, reason: blocked }
      : applies
        ? { available: true }
        : { available: false, reason: empty };
  return [
    {
      id: "newConversation",
      label: "New conversation",
      destructive: false,
      consequence:
        "The Project Manager starts a fresh conversation. The current conversation, plan and tasks move to History. Project files, settings and the connection are not changed.",
      ...gate(hasConversation, "There is no conversation yet."),
    },
    {
      id: "newRun",
      label: "Start a new run",
      destructive: false,
      consequence:
        "Clears the plan approval, tasks and run state; the conversation stays and the previous plan and evidence move to History. Source files and connection settings are not changed.",
      ...gate(hasRun, "There is no run to reset."),
    },
    project.archived
      ? {
          id: "unarchive",
          label: "Restore from archive",
          destructive: false,
          consequence: "Returns the project to the active list.",
          available: true,
        }
      : {
          id: "archive",
          label: "Archive",
          destructive: false,
          consequence:
            "Keeps all history and files but removes the project from ordinary active use. You can restore it later.",
          ...gate(true, ""),
        },
    {
      id: "remove",
      label: "Remove from Dispatch…",
      destructive: true,
      consequence:
        "Deletes this project's Dispatch-owned state: conversation, plans, tasks, evidence and its saved permission exceptions. The attached folder or repository, global settings and other projects are not touched.",
      ...gate(true, ""),
    },
  ];
}
