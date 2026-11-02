/** What the footer offers: action hints, the composer hint, needs-input prompts and notices. */

import { autopilotMessageHint, autopilotTakesMessages } from "@shared/autopilot-card";
import { composerSendBlocked } from "@shared/composer-guard";
import {
  type ActionControl,
  actionControl,
  type NextAction,
  type ProjectStatusView,
} from "@shared/project-status";
import { type AppStateView, type ProjectSnapshot } from "@shared/types";
import { type KeyHint, rule, wrap, wrapExact } from "./chrome.js";
import { type Colours, PLAIN } from "./colour.js";
import { renderApproval, renderPlan } from "./render-cards.js";
import { KEY_HINTS, withCommands } from "./render-text.js";

/**
 * What to do next, named the way it is actually invoked. Only a decision is
 * answered by a bare key; everything else is a command, because a letter
 * shortcut would swallow the first character of a sentence.
 *
 * Actions you take by typing into the composer are not listed: the composer's
 * own prompt already says what to type, and naming them twice produced lines
 * like "type a message Message the manager" — two halves of one idea, run
 * together, directly above a hint saying the same thing.
 */
export function actionHints(actions: NextAction[]): KeyHint[] {
  const INVOKED_BY_TYPING = new Set(["send_message", "reply", "choose", "wait"]);
  return actions
    .filter((action) => !INVOKED_BY_TYPING.has(action.id))
    .flatMap((action) => {
      const control = actionControl(action);
      const invocation =
        control?.control === "approval_card"
          ? `[${KEY_HINTS.allowOnce}]`
          : control && control.control in CONTROL_COMMANDS
            ? CONTROL_COMMANDS[control.control as keyof typeof CONTROL_COMMANDS]
            : undefined;
      return invocation ? [{ key: invocation, label: action.label }] : [];
    });
}

/** The same actions as one plain line, for a pipe. */
export function renderActions(actions: NextAction[]): string[] {
  const named = actionHints(actions).map((hint) => `${hint.key}  ${hint.label}`);
  return named.length ? [named.join("     ")] : [];
}

/** The terminal command for each host control a next action can call. */
export const CONTROL_COMMANDS = {
  approvePlan: "/approve",
  startRun: "/resume",
  pauseRun: "/pause",
  cancelRun: "/cancel",
  reopenRun: "/reopen",
  overrideRun: "/override <reason>",
  retryTask: "/retry",
} as const satisfies Partial<Record<ActionControl["control"], string>>;

/**
 * What the composer will do, or why it will not send. `blocked` is the
 * difference: a placeholder invites typing, a reason says the box is not the
 * thing to use right now.
 */
export function composerHint(
  state: AppStateView,
  status?: ProjectStatusView,
): { text: string; blocked: boolean } {
  const blocked = composerSendBlocked({
    approvals: state.approvals,
    needsInput: state.snapshot?.project.needsInput,
    projectId: state.selectedProjectId,
  });
  if (blocked) return { text: blocked, blocked: true };
  // While a run holds the project, or waits for the owner's answer, the host
  // sends what is typed to it, not to the manager.
  if (state.autopilot && autopilotTakesMessages(state.autopilot))
    return { text: autopilotMessageHint(state.autopilot.phase), blocked: false };
  return { text: status?.composerPlaceholder ?? "Describe what you want built.", blocked: false };
}

/** The prompt line, or why the composer will not send. */
export function renderComposerHint(state: AppStateView, status?: ProjectStatusView): string {
  return composerHint(state, status).text;
}

/** The manager's question and its numbered choices, if it offered any. */
export function renderNeedsInput(
  needsInput: NonNullable<ProjectSnapshot["project"]["needsInput"]>,
  width: number,
  colours: Colours = PLAIN,
): string[] {
  const lines = [
    rule(width, needsInputTitle(needsInput).toLowerCase(), colours, "accent2"),
    ...wrap(needsInput.question, width),
  ];
  const choices = needsInput.choices ?? [];
  choices.forEach((choice, index) => {
    lines.push(`  ${colours.paint("accent", `[${index + 1}]`)} ${choice.label}`);
  });
  lines.push(rule(width, undefined, colours));
  return lines;
}

/**
 * Only a manager's question is the manager asking; a route change or a
 * configuration block is Dispatch saying something needs you.
 */
export function needsInputTitle(
  needsInput: NonNullable<ProjectSnapshot["project"]["needsInput"]>,
): string {
  return !needsInput.kind || needsInput.kind === "question"
    ? "The manager is asking"
    : "Needs your decision";
}

/**
 * What Dispatch has to say that is not a message: the last notice (an error
 * in the fault colour, the rest plain) and anything recovery is waiting on.
 * Each is marked in words-free glyphs — `!` for a problem, `·` for news — so
 * an error is unmistakable with colour off.
 */
export function renderNotices(
  state: AppStateView,
  width: number,
  colours: Colours = PLAIN,
): string[] {
  const lines: string[] = [];
  const notice = state.notice;
  if (notice) {
    const error = notice.kind === "error";
    const mark = error ? "!" : "·";
    // A notice may be a table (`/models`), so its spacing is kept; a word-wrap
    // that rejoins words with single spaces would fold the columns into one.
    const body = wrapExact(notice.text, width - 2);
    for (const [index, line] of body.entries()) {
      const lead = index === 0 ? `${mark} ` : "  ";
      lines.push(
        error
          ? colours.paint("fault", `${lead}${line}`)
          : `${colours.paint("accent", lead)}${withCommands(colours, line)}`,
      );
    }
  }
  for (const recovery of state.recovery ?? []) {
    const text = `· ${recovery.title} — ${recovery.nextAction}`;
    for (const [index, line] of wrap(text, width).entries())
      lines.push(colours.paint("review", index === 0 ? line : `  ${line.trimStart()}`));
  }
  return lines;
}

/**
 * Everything below the transcript for a pipe: the decision (which replaces
 * the plan and the question while it is up, because it is the only thing left
 * to act on), the notice, recovery, and what a command does right now.
 */
export function renderConversationFooter(
  state: AppStateView,
  snapshot: ProjectSnapshot,
  status: ProjectStatusView,
  width: number,
  /** False when the caller pins the cards itself, as the interactive TUI does. */
  cards = true,
  colours: Colours = PLAIN,
): string[] {
  const lines: string[] = [];
  const pending = (state.approvals ?? []).find(
    (item) => !item.projectId || item.projectId === state.selectedProjectId,
  );
  if (!cards) {
    // Pinned elsewhere.
  } else if (pending) {
    lines.push(...renderApproval(pending, width, colours));
  } else {
    lines.push(...renderPlan(snapshot, width, colours));
    if (snapshot.project.needsInput)
      lines.push(...renderNeedsInput(snapshot.project.needsInput, width, colours));
  }

  const notices = renderNotices(state, width, colours);
  if (state.notice) lines.push("");
  lines.push(...notices);
  const actions = renderActions(status.actions);
  if (actions.length) lines.push(...actions);
  return lines;
}
