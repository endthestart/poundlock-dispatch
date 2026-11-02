/** The task list: one row per task, with its checks and evidence beneath. */

import { type CaseStage } from "@shared/auto-run";
import { IN_FLIGHT_OR_REVIEW, planProgressEvidence } from "@shared/project-status";
import { stuckCategoryLabel } from "@shared/stuck-task";
import {
  autopilotBoard,
  autopilotTaskView,
  changedFiles,
  managerDecisionText,
  taskStateView,
} from "@shared/task-view";
import { type AppStateView, resolveTaskRoute, type TaskRecord } from "@shared/types";
import { runBoardLines } from "./board-run.js";
import { labelled, wrap } from "./chrome.js";
import { type ColourRole, type Colours, roleForTone } from "./colour.js";
import { heading } from "./render-text.js";

/**
 * The one mark for each task state, in plain ASCII so it does not depend on
 * the font: `[x]` accepted, `[v]` verified by Autopilot's checks, `[>]` running, `[?]` waiting on a decision or a
 * review, `[~]` being repaired, `[ ]` not started (up next, or held back by an
 * earlier task), `[!]` failed, `[-]` cancelled. The label from `@shared`
 * always follows it, so state is never the mark alone.
 */
const TASK_MARK: Record<ReturnType<typeof taskStateView>["icon"], string> = {
  check: "x",
  verified: "v",
  running: ">",
  review: "?",
  repair: "~",
  queued: " ",
  blocked: " ",
  failed: "!",
  cancelled: "-",
};

/** `[x] ` and its width: the indent everything about a task hangs from. */
const MARK_INDENT = "    ";

/** How a check's outcome is painted: passed is ok, failed is a fault, anything else is just said. */
function checkRole(status: string): ColourRole {
  if (/^(passed|ok|success)/i.test(status)) return "ok";
  if (/^(failed|error)/i.test(status)) return "fault";
  return "muted";
}

/**
 * One task, the way the desktop app's Tasks list shows it: a mark and the
 * title, then its state in words with where it runs and which model is on it.
 * The evidence — files, checks, the manager's decision — sits under it,
 * labelled, the same fields the desktop app's task details list.
 */
function taskRows(
  task: TaskRecord,
  number: number,
  width: number,
  colours: Colours,
  stage?: CaseStage,
): string[] {
  // A run's task shows where Autopilot has it, not where interactive work left it.
  const view = stage ? autopilotTaskView(stage) : taskStateView(task.status);
  const role = roleForTone(view.tone);
  const attempt = task.attempts.at(-1);
  const titleRole: ColourRole | undefined = view.tone === "muted" ? "ended" : undefined;
  // Numbered as `/task <number>` opens it.
  const lines = wrap(`${number}. ${task.title}`, Math.max(1, width - MARK_INDENT.length)).map(
    (line, index) => {
      const mark = index === 0 ? colours.paint(role, `[${TASK_MARK[view.icon]}]`) : "   ";
      return `${mark} ${titleRole ? colours.paint(titleRole, line) : line}`;
    },
  );

  const worker = IN_FLIGHT_OR_REVIEW.includes(task.status)
    ? attempt?.profileName || task.profileName
    : undefined;
  const meta = [
    resolveTaskRoute(task),
    worker,
    task.attempts.length > 1 ? `attempt ${attempt?.number}` : undefined,
  ].filter(Boolean);
  lines.push(
    `${MARK_INDENT}${colours.paint(role, view.label)}${meta.length ? colours.paint("faint", ` · ${meta.join(" · ")}`) : ""}`,
  );

  const detail = (label: string, value: string, tone?: ColourRole) => {
    for (const row of labelled(
      colours,
      label,
      value,
      Math.max(1, width - MARK_INDENT.length),
      7,
      tone,
    ))
      lines.push(`${MARK_INDENT}${row}`);
  };
  const files = [
    ...new Set((attempt?.result?.patches ?? []).flatMap((patch) => changedFiles(patch.patch))),
  ];
  if (files.length) {
    const shown = files.slice(0, 6).join(", ");
    detail("changed", files.length > 6 ? `${shown} and ${files.length - 6} more` : shown);
  }
  const verification = attempt?.result?.verification;
  if (verification?.status)
    detail(
      "checks",
      `${verification.status}${verification.reason ? ` — ${verification.reason}` : ""}`,
      checkRole(verification.status),
    );
  if (attempt?.review)
    detail(
      "review",
      `Requested attempt ${attempt.review.nextAttempt} (${attempt.review.decision}): ${attempt.review.reason}`,
    );
  if (["applied", "needs_review", "repairing", "failed", "cancelled"].includes(task.status))
    detail("manager", managerDecisionText(task));
  if (task.stuck)
    detail("stuck", `${stuckCategoryLabel(task.stuck.category)}: ${task.stuck.reason}`, "review");
  if (attempt?.error) detail("error", attempt.error, "fault");
  return lines;
}

export function renderTasks(state: AppStateView, width: number, colours: Colours): string[] {
  const snapshot = state.snapshot!;
  const tasks = snapshot.tasks;
  if (!tasks.length) return ["No tasks yet. Describe what you want built."];
  const plan = snapshot.pendingBoard?.plan ?? snapshot.plan;
  const lines = heading(
    colours,
    plan?.approved === false ? "Proposed tasks" : "Tasks",
    undefined,
    width,
  );
  const numbers = new Map(tasks.map((task, index) => [task.id, index + 1]));
  const board = autopilotBoard(tasks, plan?.milestones ?? [], state.autopilot);
  if (board)
    return [
      ...lines,
      ...runBoardLines(
        board,
        (task, stage) => taskRows(task, numbers.get(task.id)!, width, colours, stage),
        width,
        colours,
      ),
    ];
  lines.push(colours.paint("muted", planProgressEvidence(tasks)), "");
  for (const task of tasks)
    lines.push(...taskRows(task, numbers.get(task.id)!, width, colours), "");
  lines.push(
    ...wrap(
      "[x] means the Project Manager accepted the work. /task <number> opens a task's evidence; message the manager to change the plan.",
      width,
    ).map((line) => colours.paint("faint", line)),
  );
  return lines;
}
