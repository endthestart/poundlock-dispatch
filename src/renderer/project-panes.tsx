import type { TaskChange } from "@shared/board-changes";
import { compactionEvidenceText, compactionsFromProvenance } from "@shared/compaction";
import { milestoneGroups } from "@shared/milestones";
import { projectReach } from "@shared/network";
import {
  effectiveToolTrust,
  planApprovalLabel,
  TOOL_TRUST_MODES,
  type ToolTrustMode,
  toolTrustLabel,
} from "@shared/permissions";
import { fixRoundsPerTask, MAX_RECOVERIES_PER_TASK } from "@shared/policy-limits";
import {
  environmentView,
  IN_FLIGHT_OR_REVIEW,
  planProgressEvidence,
  projectStatusView,
  taskExecutionView,
} from "@shared/project-status";
import { conversationReasoningView, reasoningLabel } from "@shared/reasoning";
import { ledgerLine, openIssues, requirementCoverage } from "@shared/requirements";
import { destinationLabel } from "@shared/roles";
import { visibleComposerInfolets } from "@shared/status-infolets";
import { stuckCategoryLabel } from "@shared/stuck-task";
import {
  attemptStatusLabel,
  autopilotProgressLine,
  autopilotTaskView,
  autopilotUnfinished,
  changedFiles,
  managerDecisionText,
  type TaskStateView,
  taskStateView,
} from "@shared/task-view";
import {
  type AppStateView,
  type ChatMessage,
  type LiveWorkEntry,
  type PlanRecord,
  QUESTION_OPTION_PREFIX,
  type ReasoningChoice,
  type Requirement,
  TASK_EXECUTION_PLACE,
  type TaskRecord,
} from "@shared/types";
import { Fragment, useEffect, useRef, useState } from "react";
import { ApprovalPanel } from "./approvals";
import { ConfirmDialog, Dialog, useMenu } from "./dialog";
import { Markdown } from "./Markdown";

type Snapshot = NonNullable<AppStateView["snapshot"]>;
type Run = <T>(work: () => Promise<T>) => Promise<T | undefined>;

function liveWorkClock(at: string): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The permanent, per-turn tool-call trace saved on the message itself
 * (`ChatMessage.toolTrace`). Rendered right on the manager's reply so the
 * steps that produced it read in the order they actually happened, instead
 * of trailing after every later message via the transient live-work log.
 */
export function MessageToolTrace({ trace }: { trace: ChatMessage["toolTrace"] }) {
  if (!trace?.length) return null;
  const failed = trace.filter((item) => item.error).length;
  // Collapsed by default: the steps are evidence, not part of what the manager said.
  return (
    <details className="message-tool-trace">
      <summary>
        {trace.length === 1 ? "1 step" : `${trace.length} steps`}
        {failed ? ` · ${failed} failed` : ""}
      </summary>
      <MessageToolSteps trace={trace} />
    </details>
  );
}

function isQuestionOption(id: string): boolean {
  return id.startsWith(QUESTION_OPTION_PREFIX);
}

function MessageToolSteps({ trace }: { trace: NonNullable<ChatMessage["toolTrace"]> }) {
  return (
    <ol className="live-work">
      {trace.map((item, index) => (
        <li key={`${index}:${item.name}`} className={item.error ? "error" : undefined}>
          <span className="live-work-time" aria-hidden="true" />
          <span className={item.error ? "activity-line" : undefined}>
            {item.error ? <span className="sr-only">Error: </span> : null}
            {item.summary}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function LiveWorkEvent({ entry }: { entry: LiveWorkEntry }) {
  return (
    <div className="live-work-in-transcript">
      <ol className="live-work">
        <li>
          <time dateTime={entry.at}>{liveWorkClock(entry.at)}</time>
          <span>{entry.text}</span>
        </li>
      </ol>
    </div>
  );
}

export function LiveWorkLog({ activity, place }: { activity?: string; place?: string }) {
  if (!activity?.trim()) return null;
  return (
    <div className="live-work-in-transcript" aria-live="polite" aria-busy="true">
      <ol className="live-work">
        <li className="current">
          <span className="live-work-time" aria-hidden="true" />
          <span className="activity-line busy">{activity}</span>
        </li>
      </ol>
      {place ? <span className="live-work-place">{place}</span> : null}
    </div>
  );
}

function PlanDetails({
  plan,
  tasks,
  state,
  selected,
}: {
  plan: PlanRecord;
  tasks: TaskRecord[];
  state: AppStateView;
  selected: Snapshot;
}) {
  const project = selected.project;
  const checks = plan.verificationCommands ?? project.policy.verification.commands;
  const environment = environmentView(plan, project);
  return (
    <>
      {plan.authority ? (
        <>
          <h4>Authority</h4>
          <Markdown text={plan.authority} />
        </>
      ) : null}
      {plan.acceptanceCriteria.length ? (
        <>
          <h4>Acceptance criteria</h4>
          <ul className="plain-list">
            {plan.acceptanceCriteria.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {plan.milestones?.length ? (
        <>
          <h4>Milestones</h4>
          <ol className="plain-list">
            {plan.milestones.map((milestone) => {
              const planned = tasks.filter((task) => task.milestoneId === milestone.id).length;
              return (
                <li key={milestone.id}>
                  <strong>
                    {milestone.id} · {milestone.title}
                  </strong>
                  <span className="detail-text"> — {milestone.goal}</span>
                  <span className="hint">
                    {" "}
                    {milestone.requirementIds.join(", ")} ·{" "}
                    {planned
                      ? `${planned} task${planned === 1 ? "" : "s"} planned`
                      : "planned when Autopilot gets there"}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
      {plan.architecture ? (
        <>
          <h4>Architecture</h4>
          <Markdown text={plan.architecture} />
        </>
      ) : null}
      {plan.scopeOut?.length ? (
        <>
          <h4>Out of scope</h4>
          <ul className="plain-list">
            {plan.scopeOut.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {plan.requirements?.length ? (
        <RequirementLedger requirements={plan.requirements} tasks={tasks} />
      ) : null}
      {openIssues(plan.issues).length ? (
        <>
          <h4>Questions noted for you</h4>
          <ul className="plain-list">
            {openIssues(plan.issues).map((issue) => (
              <li key={issue.notedAt + issue.text}>
                {issue.requirementId ? `${issue.requirementId}: ` : ""}
                {issue.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4>Environment and downloads</h4>
      <p className="detail-text">
        <strong>{environment.title}.</strong> {environment.detail}{" "}
        {environment.recovery ? `${environment.recovery} ` : ""}
        Dependency downloads {projectReach(project.policy).internet ? "are" : "are not"} available:
        this project&apos;s Internet switch is{" "}
        {projectReach(project.policy).internet ? "on" : "off"}
        {effectiveToolTrust(project.policy.toolTrust, state.permissions) === "ask"
          ? ". Ask mode still asks before lifecycle scripts and shell commands"
          : ""}
        .
      </p>
      <h4>Included checks</h4>
      {checks.length ? (
        <pre className="code-block">{checks.join("\n")}</pre>
      ) : (
        <p className="detail-text">The manager reviews the deliverable.</p>
      )}
      {tasks.length ? (
        <>
          <h4>Tasks and execution paths</h4>
          <ol className="plain-list">
            {tasks.map((task) => {
              const execution = taskExecutionView(task, state.connection);
              return (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  {task.requirementIds?.length ? (
                    <span className="task-badge">Serves {task.requirementIds.join(", ")}</span>
                  ) : null}
                  {task.writesTests ? (
                    <span className="task-badge">Writes tests, frozen once accepted</span>
                  ) : null}
                  {task.changesFrozenTests ? (
                    <span className="task-badge warn">Changes frozen tests</span>
                  ) : null}
                  <span className="detail-text">
                    {" "}
                    — {execution.title}. {execution.detail}
                  </span>
                  {task.filesToTouch?.length ? (
                    <span className="hint"> Files: {task.filesToTouch.join(", ")}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </>
  );
}

/**
 * The owner's requirements, what serves each and whether the accepted work
 * covers it, so a plan rewrite that drops a requirement does not go
 * unnoticed.
 */
function RequirementLedger({
  requirements,
  tasks,
}: {
  requirements: Requirement[];
  tasks: TaskRecord[];
}) {
  const serving = (id: string) =>
    tasks.filter((task) =>
      (task.requirementIds ?? []).some(
        (cited) => cited.trim().toUpperCase() === id.trim().toUpperCase(),
      ),
    );
  return (
    <>
      <h4>Requirements · {ledgerLine(requirements)}</h4>
      <ul className="plain-list">
        {requirements.map((item) => {
          const tasksFor = serving(item.id);
          return (
            <li key={item.id}>
              <strong>{item.id}</strong> {item.text}
              <span
                className={`task-badge${item.status === "open" && !tasksFor.length ? " warn-text" : ""}`}
              >
                {item.status === "done"
                  ? "Done"
                  : item.status === "waived"
                    ? "Waived by you"
                    : tasksFor.length
                      ? "Open"
                      : "No task yet"}
              </span>
              {item.scenarios.length ? (
                <div className="detail-text">Shown by: {item.scenarios.join("; ")}</div>
              ) : null}
              {tasksFor.length ? (
                <div className="detail-text">
                  Served by: {tasksFor.map((task) => task.title).join(", ")}
                </div>
              ) : null}
              {item.status === "waived" && item.evidence ? (
                <div className="detail-text">{item.evidence}</div>
              ) : null}
              {item.status === "done" && item.verdict ? (
                <div
                  className={`detail-text${item.verdict.result === "shown" ? "" : " warn-text"}`}
                >
                  Verifier: {item.verdict.result}
                  {item.verdict.note ? ` — ${item.verdict.note}` : ""}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const BOARD_CHANGES_SHOWN = 12;

/**
 * What approving a board update changes, task by task. An update that
 * rewrote fifteen task specifications to "placeholder" was approved because
 * the card showed only what it removed (13 Oct).
 */
function BoardChanges({ changes }: { changes: TaskChange[] }) {
  if (!changes.length)
    return <p className="detail-text">Approving this changes no published task.</p>;
  const shown = changes.slice(0, BOARD_CHANGES_SHOWN);
  const removed = changes.some((change) => change.change === "removed");
  return (
    <div className="board-changes" role={removed ? "alert" : undefined}>
      <p className="detail-text">Approving this:</p>
      <ul>
        {shown.map((change) => (
          <li
            key={`${change.change}:${change.title}`}
            className={change.change === "removed" ? "warn-text" : undefined}
          >
            {change.change === "added"
              ? `Adds “${change.title}”`
              : change.change === "removed"
                ? `Removes “${change.title}”`
                : `Changes the ${change.fields.join(", ")} of “${change.title}”`}
          </li>
        ))}
        {changes.length > shown.length ? <li>and {changes.length - shown.length} more</li> : null}
      </ul>
    </div>
  );
}

/** " No task yet for R2 (Organize photos)." or an empty string. */
function uncoveredLine(requirements: Requirement[], tasks: TaskRecord[]): string {
  const uncovered = requirementCoverage(requirements, tasks).uncovered;
  return uncovered.length
    ? ` No task yet for ${uncovered.map((item) => `${item.id} (${item.text})`).join(", ")}.`
    : "";
}

/** A plan awaiting approval, shown once in the conversation where it is decided. */
export function PlanProposal({ state, selected }: { state: AppStateView; selected: Snapshot }) {
  const plan = selected.pendingBoard?.plan ?? selected.plan;
  if (!plan || (selected.plan?.approved && !selected.pendingBoard)) return null;
  const tasks = selected.pendingBoard?.tasks ?? selected.tasks;
  const summaryInChat = selected.messages.some((m) => m.text.includes(plan.summary));
  // An update replaces the board; name what approving it would remove.
  const proposedTitles = new Set(tasks.map((task) => task.title.trim().toLowerCase()));
  const dropped = selected.pendingBoard
    ? selected.tasks.filter((task) => !proposedTitles.has(task.title.trim().toLowerCase()))
    : [];
  return (
    <article className="proposal" aria-labelledby="proposal-title">
      <header>
        <h3 id="proposal-title">
          {selected.pendingBoard ? "Proposed plan update" : "Proposed plan"}
        </h3>
        <span className="meta">Revision {plan.revision} · waiting for your approval</span>
      </header>
      {selected.pendingBoard ? (
        <p className="detail-text">
          {selected.pendingBoard.reason ||
            "The Project Manager proposed a change. The current task list stays in place until you approve it."}
        </p>
      ) : null}
      {!summaryInChat ? <Markdown text={plan.summary} /> : null}
      {plan.requirements?.length ? (
        <p className="detail-text">
          Requirements: {ledgerLine(plan.requirements)}.{uncoveredLine(plan.requirements, tasks)}
        </p>
      ) : null}
      {selected.pendingBoard?.changes ? (
        <BoardChanges changes={selected.pendingBoard.changes} />
      ) : dropped.length ? (
        <p className="detail-text warn-text" role="alert">
          Approving this removes {dropped.length} current task{dropped.length === 1 ? "" : "s"}:{" "}
          {dropped.map((task) => task.title).join(", ")}.
        </p>
      ) : null}
      <details className="disclosure">
        <summary>
          Authority, checks and {tasks.length === 1 ? "task" : `${tasks.length} tasks`}
        </summary>
        <PlanDetails plan={plan} tasks={tasks} state={state} selected={selected} />
      </details>
    </article>
  );
}

/**
 * The single actionable home for decisions: recovery notices, manager
 * questions, run actions and the pending approval, docked above the composer.
 */
export function DecisionDock({
  state,
  selected,
  run,
  onState,
}: {
  state: AppStateView;
  selected: Snapshot;
  run: Run;
  onState: (state: AppStateView) => void;
}) {
  const [pending, setPending] = useState("");
  const [dialog, setDialog] = useState<"override" | "cancel">();
  const pendingRef = useRef(false);
  const status = projectStatusView(selected, { approvals: state.approvals });
  const project = selected.project;
  const plan = selected.pendingBoard?.plan ?? selected.plan;
  async function act(label: string, work: () => Promise<unknown>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    try {
      await run(work);
    } finally {
      pendingRef.current = false;
      setPending("");
    }
  }
  const disabled = Boolean(pending) || state.busy;
  // Only a manager question is "asked"; environment, configuration and other
  // Dispatch-raised blocks use the shared status derivation's wording.
  const question =
    project.needsInput && project.status !== "paused" && status.cause === "question"
      ? project.needsInput
      : undefined;
  const questionOptions = (question?.choices ?? []).filter((choice) => isQuestionOption(choice.id));
  // Dispatch's own decisions (a folder request, a route change) carry their buttons here too.
  const decision =
    project.needsInput && project.status !== "paused" && status.cause === "decision"
      ? project.needsInput
      : undefined;
  const canOverride = status.canOverride;
  const canCancel = status.canCancel;
  const retryTaskAction = status.actions.find((action) => action.id === "retry_task");
  const actions =
    status.canApprove || status.canResume || status.canReopen || status.active || canCancel;
  const recovery = state.recovery ?? [];
  const approvals = (state.approvals ?? []).length > 0;
  const showStatus =
    actions ||
    Boolean(project.needsInput) ||
    ["paused", "failed", "cancelled", "waiting_for_capacity"].includes(project.status);
  if (!showStatus && !recovery.length && !approvals) return null;
  const questionInChat = question
    ? selected.messages.some((message) => message.text.includes(question.question))
    : true;

  return (
    <section className="decision-dock" aria-label="Decisions and run actions">
      <ApprovalPanel state={state} onState={onState} selectedProjectId={project.id} />
      {recovery.map((notice) => (
        <div key={`${notice.kind}:${notice.title}`} className="dock-block recovery" role="status">
          <strong>{notice.title}</strong>
          <p>{notice.detail}</p>
          <p className="hint">{notice.nextAction}</p>
        </div>
      ))}
      {showStatus ? (
        <div className="dock-block" aria-live="polite" aria-busy={Boolean(pending)}>
          <div className="dock-status">
            <strong>{question ? "The Project Manager asked you" : status.title}</strong>
            <span className="hint">
              {question
                ? questionOptions.length
                  ? "Choose an answer, or reply in your own words below."
                  : "Reply in the message box below."
                : status.canApprove
                  ? "Review the proposed plan above. Approve and start begins work within the listed permissions."
                  : status.next}
            </span>
          </div>
          {question && !questionInChat ? <Markdown text={question.question} /> : null}
          {decision?.kind === "folder_access" && decision.folder ? (
            <p className="folder-request">
              <code>{decision.folder.path}</code>
              {decision.folder.reason ? (
                <span className="hint">{decision.folder.reason}</span>
              ) : null}
            </p>
          ) : null}
          {questionOptions.length ? (
            <div className="question-options">
              {questionOptions.map((choice) => (
                <button
                  type="button"
                  key={choice.id}
                  className="question-option"
                  disabled={disabled}
                  onClick={() =>
                    void act(`${choice.label} — sent`, () =>
                      window.poundlockDispatch.replyInput(choice.id),
                    )
                  }
                >
                  <strong>{choice.label}</strong>
                  {choice.description ? <span className="hint">{choice.description}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          {pending ? (
            <p role="status" className="action-receipt">
              {pending}
            </p>
          ) : null}
          <div className="dock-actions">
            {(question ?? decision)?.choices
              ?.filter((choice) => choice.id !== "wait" && !isQuestionOption(choice.id))
              .map((choice) => (
                <button
                  type="button"
                  key={choice.id}
                  disabled={disabled}
                  onClick={() =>
                    void act(`${choice.label} — processing…`, () =>
                      window.poundlockDispatch.replyInput(choice.id),
                    )
                  }
                >
                  {choice.label}
                </button>
              ))}
            {status.canApprove ? (
              <button
                type="button"
                className="primary"
                disabled={disabled}
                onClick={() =>
                  void act("Approval registered — starting…", () =>
                    window.poundlockDispatch.approvePlan(),
                  )
                }
              >
                Approve and start
              </button>
            ) : null}
            {status.canResume ? (
              <button
                type="button"
                className="primary"
                disabled={disabled}
                onClick={() =>
                  void act("Resume registered — checking saved work…", () =>
                    window.poundlockDispatch.startRun(),
                  )
                }
              >
                Resume
              </button>
            ) : null}
            {status.canReopen ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void act("Sending completed work for another review…", () =>
                    window.poundlockDispatch.reopenRun(),
                  )
                }
              >
                Review completed work again
              </button>
            ) : null}
            {retryTaskAction ? (
              <button
                type="button"
                className="primary"
                disabled={disabled}
                onClick={() =>
                  void act("Retrying the task — starting fresh…", () =>
                    window.poundlockDispatch.retryTask(retryTaskAction.taskId!),
                  )
                }
              >
                {retryTaskAction.label}
              </button>
            ) : null}
            {question || (status.canApprove && project.status !== "paused") ? (
              <button
                type="button"
                disabled={Boolean(pending)}
                onClick={() =>
                  void act("Wait selected — pausing…", () => window.poundlockDispatch.pauseRun())
                }
              >
                Wait
              </button>
            ) : null}
            {status.canPause ? (
              <button
                type="button"
                disabled={Boolean(pending)}
                onClick={() =>
                  void act("Pause registered — stopping active work…", () =>
                    window.poundlockDispatch.pauseRun(),
                  )
                }
              >
                Pause
              </button>
            ) : null}
            {canOverride ? (
              <button
                type="button"
                className="quiet"
                disabled={disabled}
                onClick={() => setDialog("override")}
              >
                Override…
              </button>
            ) : null}
            {canCancel ? (
              <button
                type="button"
                className="danger quiet"
                disabled={Boolean(pending)}
                onClick={() => setDialog("cancel")}
              >
                Cancel run
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {dialog === "override" ? (
        <OverrideDialog
          onClose={() => setDialog(undefined)}
          onSubmit={(reason) =>
            act("Override recorded…", () => window.poundlockDispatch.overrideRun(reason))
          }
        />
      ) : null}
      {dialog === "cancel" ? (
        <ConfirmDialog
          title="Cancel this run?"
          body="Active workers stop. The conversation, plan and results so far are kept, and project files are not reverted."
          confirmLabel="Cancel run"
          destructive
          onClose={() => setDialog(undefined)}
          onConfirm={() =>
            act("Cancel registered — cancelling…", () => window.poundlockDispatch.cancelRun())
          }
        />
      ) : null}
    </section>
  );
}

function OverrideDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Record an override"
      description="Records your decision as a note in the conversation for the manager. It does not retry, approve or change anything, and Dispatch infers no extra permission from it."
      onClose={onClose}
      busy={busy}
      initialFocus="textarea"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!reason.trim()) return;
          setBusy(true);
          void onSubmit(reason.trim()).finally(() => {
            setBusy(false);
            onClose();
          });
        }}
      >
        <label htmlFor="override-reason">Override and authority</label>
        <textarea
          id="override-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !reason.trim()}>
            Record override
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TaskStateIcon({ view }: { view: TaskStateView }) {
  return (
    <span className={`task-icon ${view.icon} tone-${view.tone}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
        {view.icon === "check" ? (
          <>
            <circle cx="8" cy="8" r="7" className="fill" />
            <path d="M4.6 8.3l2.2 2.2 4.6-4.8" className="mark" />
          </>
        ) : view.icon === "verified" ? (
          <>
            <circle cx="8" cy="8" r="6.2" className="ring" />
            <path d="M4.9 8.2l2 2 4.2-4.4" className="stroke" />
          </>
        ) : view.icon === "running" ? (
          <>
            <circle cx="8" cy="8" r="6.2" className="ring" />
            <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" className="arc" />
          </>
        ) : view.icon === "repair" ? (
          <>
            <circle cx="8" cy="8" r="6.2" className="ring" />
            <path d="M5 8a3 3 0 1 0 1-2.2M5 4.6v1.8h1.8" className="stroke" />
          </>
        ) : view.icon === "review" ? (
          <>
            <circle cx="8" cy="8" r="6.2" className="ring" />
            <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" className="half" />
          </>
        ) : view.icon === "blocked" ? (
          <>
            <circle cx="8" cy="8" r="6.2" className="ring dashed" />
            <path d="M5.5 8h5" className="stroke" />
          </>
        ) : view.icon === "failed" ? (
          <>
            <circle cx="8" cy="8" r="6.2" className="ring" />
            <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" className="stroke" />
          </>
        ) : view.icon === "cancelled" ? (
          <>
            <circle cx="8" cy="8" r="6.2" className="ring dashed" />
            <path d="M3.8 12.2l8.4-8.4" className="stroke" />
          </>
        ) : (
          <circle cx="8" cy="8" r="6.2" className="ring" />
        )}
      </svg>
    </span>
  );
}

/** Right column: approved plan and revision, task progress and per-task evidence. */
export function Inspector({
  state,
  selected,
  expanded,
  onToggleTask,
}: {
  state: AppStateView;
  selected: Snapshot;
  expanded: ReadonlySet<string>;
  onToggleTask: (taskId: string, open: boolean) => void;
}) {
  const plan = selected.plan;
  const pending = selected.pendingBoard;
  const publishedTitles = new Set(selected.tasks.map((task) => task.title));
  const pendingAdded = pending?.tasks.filter((task) => !publishedTitles.has(task.title)) ?? [];
  const pendingRemoved = pending
    ? selected.tasks.filter((task) => !pending.tasks.some((item) => item.title === task.title))
    : [];
  const approved = Boolean(plan?.approved);
  // A board run's tasks show where Autopilot has them, not where interactive work left them.
  const autopilotStages = new Map(
    state.autopilot?.board ? state.autopilot.cases.map((item) => [item.id, item.stage]) : [],
  );
  const renderTask = (task: TaskRecord) => {
    // Merged or dropped work is the board's own again.
    const stage = ["applied", "cancelled"].includes(task.status)
      ? undefined
      : autopilotStages.get(task.id);
    const view = stage ? autopilotTaskView(stage) : taskStateView(task.status);
    const attempt = task.attempts.at(-1);
    const active = IN_FLIGHT_OR_REVIEW.includes(task.status);
    return (
      <li key={task.id} className={`task-item tone-${view.tone}`}>
        <details
          open={expanded.has(task.id)}
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            if (open !== expanded.has(task.id)) onToggleTask(task.id, open);
          }}
        >
          <summary className="task-row">
            <TaskStateIcon view={view} />
            <span className="task-text">
              <span className="task-title">{task.title}</span>
              <span className="task-sub">
                <span className={`state-label tone-${view.tone}`}>{view.label}</span>
                {active && (attempt?.profileName || task.profileName)
                  ? ` · ${attempt?.profileName || task.profileName}`
                  : ""}
                {task.attempts.length > 1 ? ` · attempt ${attempt?.number}` : ""}
              </span>
            </span>
          </summary>
          <TaskEvidence
            task={task}
            selected={selected}
            fixRounds={fixRoundsPerTask(
              selected.project.policy.fixRoundsPerTask,
              state.permissions.fixRoundsPerTask,
            )}
          />
        </details>
      </li>
    );
  };
  return (
    <>
      <section className="panel-section" aria-labelledby="plan-heading">
        <div className="panel-head">
          <h2 id="plan-heading">Plan</h2>
          {plan ? (
            <span className="meta">
              Revision {plan.revision} · {planApprovalLabel(plan)}
            </span>
          ) : null}
        </div>
        {!plan ? (
          <p className="hint">
            Nothing planned yet. Discuss the work in the conversation; the approved plan and its
            tasks appear here.
          </p>
        ) : approved ? (
          <>
            <div className="doc">
              <Markdown text={plan.summary} />
            </div>
            <details className="disclosure">
              <summary>Authority, checks and environment</summary>
              <PlanDetails plan={plan} tasks={[]} state={state} selected={selected} />
            </details>
          </>
        ) : (
          <p className="hint">
            The proposed plan is waiting for your approval in the conversation.
          </p>
        )}
        {pending ? (
          <div className="amendment">
            <strong>Proposed update · revision {pending.plan.revision}</strong>
            <p className="hint">
              Waiting for approval in the conversation. The task list below stays until you approve
              it.
            </p>
            {pendingAdded.length ? (
              <p className="detail-text">
                Adds: {pendingAdded.map((task) => task.title).join(", ")}
              </p>
            ) : null}
            {pendingRemoved.length ? (
              <p className="detail-text">
                Removes: {pendingRemoved.map((task) => task.title).join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      {selected.brief ? (
        <section className="panel-section" aria-labelledby="brief-heading">
          <div className="panel-head">
            <h2 id="brief-heading">Project brief</h2>
          </div>
          <details className="disclosure">
            <summary>Objectives, requirements and ADR index the manager keeps in view</summary>
            <div className="doc">
              <Markdown text={selected.brief} />
            </div>
          </details>
        </section>
      ) : null}
      {selected.tasks.length ? (
        <section className="panel-section" aria-labelledby="tasks-heading">
          <div className="panel-head">
            <h2 id="tasks-heading">{approved ? "Tasks" : "Proposed tasks"}</h2>
          </div>
          <p className="progress-line" aria-live="polite">
            {autopilotStages.size
              ? autopilotProgressLine([...autopilotStages.values()])
              : planProgressEvidence(selected.tasks)}
          </p>
          {autopilotStages.size ? (
            milestoneGroups(selected.tasks, plan?.milestones ?? []).map((group) => {
              // Earlier runs' work counts too: merged tasks are done, and tasks an
              // earlier run left blocked were replanned since. Counting only this
              // run's stages showed a finished M1 as "0 of 95" (owner, 19 Oct).
              const leftBehind = (task: TaskRecord) =>
                autopilotUnfinished(autopilotStages.get(task.id)) ||
                (!autopilotStages.has(task.id) && task.status === "blocked");
              const shown = group.tasks.filter((task) => !leftBehind(task));
              const unfinished = group.tasks.filter(leftBehind);
              const verified = group.tasks.filter(
                (task) => autopilotStages.get(task.id) === "accepted" || task.status === "applied",
              ).length;
              return (
                <div key={group.id} className="task-group">
                  {group.title ? (
                    <h3 className="task-group-head">
                      {group.title}
                      <span className="meta">
                        {verified} of {group.tasks.length - unfinished.length} verified
                      </span>
                    </h3>
                  ) : null}
                  <ol className="task-list">{shown.map(renderTask)}</ol>
                  {unfinished.length ? (
                    <details className="disclosure task-unfinished">
                      <summary>
                        {unfinished.length} did not finish; the Planner replans what they were for
                      </summary>
                      <ol className="task-list">{unfinished.map(renderTask)}</ol>
                    </details>
                  ) : null}
                </div>
              );
            })
          ) : (
            <ol className="task-list">{selected.tasks.map(renderTask)}</ol>
          )}
          <p className="hint">
            {autopilotStages.size
              ? "Verified means the project's checks passed in Autopilot's container; nobody has reviewed the work yet. Merge it from the Autopilot panel when the run ends."
              : "Checkmarks mean the Project Manager accepted the work. Worker output below each task is evidence; message the Project Manager to change the plan."}
          </p>
        </section>
      ) : null}
    </>
  );
}

export function ComposerInfolets({
  state,
  onCompact,
}: {
  state: AppStateView;
  onCompact: () => void;
}) {
  const items = visibleComposerInfolets(state);
  if (!items.length) return null;
  return (
    <div className="composer-infolets" aria-label="Composer status">
      {items.map((item) => (
        <Fragment key={item.id}>
          <span
            className={`composer-infolet${item.compactOffer ? " offer" : ""}`}
            title={item.title}
          >
            {item.text}
          </span>
          {item.compactOffer ? (
            <button
              type="button"
              className="quiet small composer-infolet-action"
              disabled={state.busy}
              title="Summarise older messages to free up context. The brief and recent turns are kept."
              onClick={onCompact}
            >
              Compact now
            </button>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

export function TrustChip({
  mode,
  busy,
  onChange,
}: {
  mode: ToolTrustMode;
  busy: boolean;
  onChange: (mode: ToolTrustMode) => void;
}) {
  const menu = useMenu();
  return (
    <div className="trust-chip">
      <button
        type="button"
        className="trust-chip-btn"
        disabled={busy}
        aria-label={`Worker permissions: ${toolTrustLabel(mode)}`}
        {...menu.triggerProps}
      >
        {toolTrustLabel(mode)}
      </button>
      {menu.open ? (
        <div
          className="trust-menu menu-popover"
          aria-label="Worker permissions"
          {...menu.menuProps}
        >
          {TOOL_TRUST_MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === mode}
              tabIndex={-1}
              className={item.id === mode ? "selected" : undefined}
              onClick={() => {
                menu.close();
                if (item.id !== mode) onChange(item.id);
              }}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The manager's reasoning for this conversation; only settings its profile offers. */
export function ReasoningChip({
  state,
  project,
  onChange,
}: {
  state: AppStateView;
  project: import("@shared/types").ProjectRecord;
  onChange: (choice: ReasoningChoice | undefined) => void;
}) {
  const menu = useMenu();
  const view = conversationReasoningView({
    project,
    roles: state.connection.roles,
    models: state.probe?.interactiveModels ?? [],
    localManager: Boolean(state.connection.localManager?.enabled && !project.managerEscalation),
  });
  if (view.offered.length < 2 && !project.reasoningOverride && !view.error) return null;
  const label = view.error
    ? "Reasoning unavailable"
    : `Reasoning: ${reasoningLabel(view.effective)}`;
  const defaultHint = !view.defaultChoice
    ? "Not usable with this model"
    : view.defaultSource === "external_manager_default"
      ? "None, because this manager is external"
      : reasoningLabel(view.defaultChoice);
  return (
    <div className="trust-chip">
      <button
        type="button"
        className={`trust-chip-btn${view.error ? " warn" : ""}`}
        title={view.error}
        aria-label={`Manager reasoning for this conversation: ${label}`}
        {...menu.triggerProps}
      >
        {label}
      </button>
      {menu.open ? (
        <div className="trust-menu menu-popover" aria-label="Manager reasoning" {...menu.menuProps}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!project.reasoningOverride}
            tabIndex={-1}
            className={!project.reasoningOverride ? "selected" : undefined}
            onClick={() => {
              menu.close();
              if (project.reasoningOverride) onChange(undefined);
            }}
          >
            <strong>Manager default</strong>
            <span>{defaultHint}. Set in Settings → Models.</span>
          </button>
          {view.offered.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={project.reasoningOverride === choice}
              tabIndex={-1}
              className={project.reasoningOverride === choice ? "selected" : undefined}
              onClick={() => {
                menu.close();
                if (project.reasoningOverride !== choice) onChange(choice);
              }}
            >
              <strong>{reasoningLabel(choice)}</strong>
              <span>
                {choice === "model_default"
                  ? "Send nothing; the model decides."
                  : choice === "none"
                    ? "Ask for no reasoning. Fastest and cheapest."
                    : "Verified on this model by Poundlock."}
              </span>
            </button>
          ))}
          {view.error ? <p className="hint">{view.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The UI snapshots an attempt's tests wrote, as the attempt recorded them. */
function snapshotNames(attempt: TaskRecord["attempts"][number]): string[] {
  const kept = attempt.result?.provenance?.snapshots;
  return Array.isArray(kept) ? kept.filter((name): name is string => typeof name === "string") : [];
}

/** Thumbnails of an attempt's snapshots; each opens full size in a new view. */
function Snapshots({ attemptId, names }: { attemptId: string; names: string[] }) {
  const [images, setImages] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    setImages({});
    for (const name of names)
      void window.poundlockDispatch
        .attemptSnapshot(attemptId, name)
        .then((url) => live && setImages((current) => ({ ...current, [name]: url })))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attemptId, names.join("\n")]);
  return (
    <div className="snapshots">
      {names.map((name) => (
        <figure key={name}>
          {images[name] ? (
            <a href={images[name]} target="_blank" rel="noreferrer">
              <img src={images[name]} alt={name} />
            </a>
          ) : (
            <div className="snapshot-placeholder" />
          )}
          <figcaption>{name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function TaskEvidence({
  task,
  selected,
  fixRounds,
}: {
  task: TaskRecord;
  selected: Snapshot;
  fixRounds: number;
}) {
  const [selectedAttempt, setSelectedAttempt] = useState<string>();
  useEffect(() => setSelectedAttempt(undefined), [task.id]);
  const attempt = task.attempts.find((item) => item.id === selectedAttempt) ?? task.attempts.at(-1);
  const patch = attempt?.result?.patches.map((item) => item.patch).join("\n") ?? "";
  const files = changedFiles(patch);
  const verification = attempt?.result?.verification;
  const workerCompacted = compactionEvidenceText(
    compactionsFromProvenance(attempt?.result?.provenance),
  );
  return (
    <div className="evidence">
      <Markdown text={task.objective} />
      <dl className="facts compact">
        <dt>Decision</dt>
        <dd>{managerDecisionText(task)}</dd>
        <dt>Attempts</dt>
        <dd>
          {task.attempts.length ? (
            task.attempts.length > 1 ? (
              <select
                aria-label={`Attempt for ${task.title}`}
                value={attempt?.id}
                onChange={(event) => setSelectedAttempt(event.target.value)}
              >
                {task.attempts.map((item) => (
                  <option key={item.id} value={item.id}>
                    Attempt {item.number} · {attemptStatusLabel(item.status)}
                  </option>
                ))}
              </select>
            ) : (
              `1 · ${attemptStatusLabel(task.attempts[0].status)}`
            )
          ) : (
            "None yet"
          )}
        </dd>
        {attempt ? (
          <>
            <dt>Worker</dt>
            <dd>
              {attempt.profileName || "Not assigned"}
              {attempt.role ? ` · ${attempt.role} role` : ""}
            </dd>
            <dt>Job</dt>
            <dd>
              {attempt.jobId ? (
                <code>{attempt.jobId}</code>
              ) : attempt.execution === "durable" ? (
                "Not submitted"
              ) : (
                "Interactive — no Poundlock job"
              )}
            </dd>
            <dt>Destination</dt>
            <dd>
              {attempt.execution === "durable" ? "Poundlock job" : "This Mac"}
              {attempt.dataDestination ? ` · ${destinationLabel(attempt.dataDestination)}` : ""}
              {attempt.routingRevision ? ` · route ${attempt.routingRevision}` : ""}
            </dd>
          </>
        ) : (
          <>
            <dt>Route</dt>
            <dd>{TASK_EXECUTION_PLACE}</dd>
          </>
        )}
        <dt>Changed files</dt>
        <dd>
          {files.length ? (
            <ul className="file-list">
              {files.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : (
            "None reported"
          )}
        </dd>
        <dt>Checks</dt>
        <dd>
          {verification ? verification.status : "Not reported"}
          {verification?.reason ? ` — ${verification.reason}` : ""}
        </dd>
        {attempt?.mutation?.mutants.length ? (
          <>
            <dt>Mutation check</dt>
            <dd>
              {attempt.mutation.mutants.filter((mutant) => mutant.caught).length} of{" "}
              {attempt.mutation.mutants.length} small breaks caught by the checks
              <ul className="file-list">
                {attempt.mutation.mutants.map((mutant) => (
                  <li key={`${mutant.path}:${mutant.line}`}>
                    <code>
                      {mutant.path}:{mutant.line}
                    </code>{" "}
                    {mutant.change} — {mutant.caught ? "caught" : "not caught"}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {attempt && snapshotNames(attempt).length ? (
          <>
            <dt>Snapshots</dt>
            <dd>
              <Snapshots attemptId={attempt.id} names={snapshotNames(attempt)} />
            </dd>
          </>
        ) : null}
        {workerCompacted ? (
          <>
            <dt>Worker context</dt>
            <dd>{workerCompacted}</dd>
          </>
        ) : null}
        {attempt?.review ? (
          <>
            <dt>Review decision</dt>
            <dd>
              Requested attempt {attempt.review.nextAttempt} ({attempt.review.decision}):{" "}
              {attempt.review.reason}
            </dd>
          </>
        ) : null}
        <dt>Fix rounds</dt>
        <dd>
          {task.repairCount} of {fixRounds} sent back by Dispatch · Retries after interruption{" "}
          {task.recoveryCount ?? 0} of {MAX_RECOVERIES_PER_TASK}
          {attempt?.profileName ? ` · Model ${attempt.profileName}` : ""}
        </dd>
        {attempt?.result?.selfRepairs ? (
          <>
            <dt>Job self-repairs</dt>
            <dd>
              {attempt.result.selfRepairs} time{attempt.result.selfRepairs === 1 ? "" : "s"} inside
              this attempt, before Dispatch saw a result — separate from the fix rounds above.
            </dd>
          </>
        ) : null}
      </dl>
      {task.stuck ? (
        <p className="notice" role="status">
          <strong>{stuckCategoryLabel(task.stuck.category)}:</strong> {task.stuck.reason}
        </p>
      ) : null}
      {attempt?.error ? (
        <p className="notice error">
          <span className="sr-only">Error: </span>
          {attempt.error}
        </p>
      ) : null}
      {verification?.commands.map((check, index) => (
        <details className="disclosure" key={`${index}:${check.command}`}>
          <summary>
            <code>{check.command}</code> · exit {check.exitCode ?? "unknown"}
          </summary>
          <pre className="code-block">{check.error || check.output || "No output"}</pre>
        </details>
      ))}
      {attempt?.result?.output ? (
        <details className="disclosure">
          <summary>Worker report</summary>
          <Markdown text={attempt.result.output} />
        </details>
      ) : null}
      {patch ? (
        <details className="disclosure">
          <summary>Diff</summary>
          <DiffView patch={patch} />
        </details>
      ) : null}
    </div>
  );
}

function DiffView({ patch }: { patch: string }) {
  return (
    <div className="diff">
      {patch.split("\n").map((line, index) => (
        <div
          key={`${index}-${line.slice(0, 12)}`}
          className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}
