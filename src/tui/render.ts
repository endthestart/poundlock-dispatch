/**
 * The terminal view, as data.
 *
 * Every function here is `AppStateView` in, `string[]` out — no terminal and
 * no pi-tui component. That keeps the screens testable as plain values, and
 * it keeps the rendering library replaceable: what the user sees is decided
 * here, how it reaches the terminal is decided in `app.ts`.
 *
 * Colour comes in as an argument. Left at the default (`PLAIN`) every function
 * returns exactly the text a test or a pipe wants; given an enabled `Colours`
 * it returns the same text with escape codes around it, so stripping them
 * gives the plain lines back (`tests/tui-render.test.ts` holds that property).
 *
 * Nothing in this file derives workflow meaning. Status, actions, approval
 * copy and whether the composer may send all come from `@shared`, which the
 * desktop app already uses, so the two front ends cannot disagree about what
 * a project is doing.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { approvalView } from "@shared/approval-view";
import { composerSendBlocked } from "@shared/composer-guard";
import { planApprovalLabel, type ToolApproval } from "@shared/permissions";
import type { ActionControl, NextAction, ProjectStatusView } from "@shared/project-status";
import {
  actionControl,
  IN_FLIGHT_OR_REVIEW,
  planProgressEvidence,
  projectStatusView,
} from "@shared/project-status";
import { reasoningLabel } from "@shared/reasoning";
import { destinationLabel } from "@shared/roles";
import { visibleComposerInfolets } from "@shared/status-infolets";
import { projectStatusTone } from "@shared/status-tone";
import { stuckCategoryLabel } from "@shared/stuck-task";
import { changedFiles, managerDecisionText, taskStateView } from "@shared/task-view";
import type { AppStateView, ChatMessage, ProjectSnapshot, TaskRecord } from "@shared/types";
import { resolveTaskRoute } from "@shared/types";
import {
  chip,
  clip,
  fitParts,
  GUTTER,
  indentBy,
  joinParts,
  type KeyHint,
  labelled,
  type Part,
  padTo,
  rule,
  spread,
  wrap,
  wrapExact,
} from "./chrome.js";
import { type ColourRole, type Colours, PLAIN, roleForTone } from "./colour.js";
import { COMMAND_DEFS } from "./commands.js";

export { wrap } from "./chrome.js";

const KEY_HINTS = {
  allowOnce: "a",
  allowAlways: "s",
  deny: "d",
  tasks: "tab",
  commands: "/",
} as const;

/** The widest a message of yours gets before it wraps, as a share of the terminal. */
export const OWN_MESSAGE_SHARE = 0.62;

/** A screen's lines, and the one line that says what the composer will do. */
interface Screen {
  lines: string[];
  hint: string;
}

/**
 * The plain transcript, with your own words set apart from the manager's.
 * This is the version a pipe gets; the terminal draws the same shape from
 * `transcript.ts`, with markdown.
 *
 * Every line used to carry an eight-column speaker gutter — `manager` once
 * and eight spaces on every wrapped line after it — which spent a tenth of
 * the terminal restating the obvious. The manager is the default voice here
 * and needs no label; what needs marking is the line you wrote.
 *
 * Your messages are set as a block against the right margin, left-aligned
 * inside it, the way a chat client does. True right-alignment would ragged
 * the left edge of anything that wrapped, which is the edge you read from.
 */
export function renderTranscript(
  messages: ChatMessage[],
  width: number,
  /** The manager's reply so far, when a turn is still running. */
  draft?: string,
): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const block = Math.max(20, Math.floor(width * OWN_MESSAGE_SHARE));
      const body = wrap(message.text, block - 2);
      const longest = Math.max(...body.map((line) => line.length), 0);
      const indent = " ".repeat(Math.max(0, width - longest - 2));
      for (const line of body) lines.push(`${indent}▏ ${line}`);
      lines.push("");
      continue;
    }
    // The manager speaks flush left, unmarked; anything else is machinery and
    // says so with a mark rather than a word.
    const marker = message.role === "manager" ? "" : "· ";
    const body = wrap(message.text, width - marker.length);
    for (const [index, line] of body.entries())
      lines.push(index === 0 ? `${marker}${line}` : `${" ".repeat(marker.length)}${line}`);
    if (message.toolTrace?.length) {
      const used = message.toolTrace.map((tool) => (tool.error ? `${tool.name}!` : tool.name));
      lines.push(`· ${used.join(", ")}`);
    }
    lines.push("");
  }
  // Laid out exactly like a finished manager message, because it is going to
  // become one. A different shape here would make the text appear to move when
  // the turn ends.
  if (draft?.trim()) {
    for (const line of wrap(draft, width)) lines.push(line);
    lines.push("");
  }
  return lines;
}

/** The slash commands that exist, longest first so `/approve-models` is never read as `/approve`. */
const COMMAND_MENTION = new RegExp(
  `(^|[\\s(])(${COMMAND_DEFS.map((command) => command.name)
    .sort((a, b) => b.length - a.length)
    .join("|")})(?![\\w-])`,
  "g",
);

/**
 * A command named inside running text, set apart so it can be found again.
 * Only commands that exist: a path that happens to start with a slash is not
 * one, and painting it as one would be a small lie.
 */
function withCommands(colours: Colours, text: string): string {
  return text.replace(
    COMMAND_MENTION,
    (_match, before: string, command: string) => `${before}${colours.paint("accent", command)}`,
  );
}

/** A section's title and a quiet aside, above a rule. */
function heading(colours: Colours, title: string, aside: string | undefined, width: number) {
  const left = colours.style("bold", colours.paint("accent", title));
  const right = aside ? colours.paint("faint", aside) : "";
  return [spread(left, right, width), rule(width, undefined, colours)];
}

/** A small heading inside a section: `Acceptance criteria`. */
function subheading(colours: Colours, text: string): string {
  return colours.style("bold", colours.paint("muted", text));
}

/** A list with hanging indents, so a wrapped item stays under its own first word. */
function bulleted(colours: Colours, items: string[], width: number, marker = "•"): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const body = wrap(item, Math.max(1, width - 4));
    for (const [index, line] of body.entries())
      lines.push(index === 0 ? `  ${colours.paint("faint", marker)} ${line}` : `    ${line}`);
  }
  return lines;
}

/**
 * A pending approval, in the ordinary language the desktop app uses. ADR 010
 * puts this decision in Dispatch's own surface rather than in a Pi prompt, and
 * a terminal is no exception.
 */
export function renderApproval(
  request: ToolApproval,
  width: number,
  colours: Colours = PLAIN,
): string[] {
  const view = approvalView(request);
  const key = (letter: string) => colours.paint("accent", `[${letter}]`);
  return [
    rule(width, "decision needed", colours, "review"),
    "",
    ...approvalCardBody(request, width, colours),
    "",
    `  ${key(KEY_HINTS.allowOnce)} ${view.once}    ${key(KEY_HINTS.allowAlways)} ${view.remember}    ${key(KEY_HINTS.deny)} ${view.deny}`,
    rule(width, undefined, colours),
  ];
}

/**
 * What an approval asks, in two parts. `facts` are the plain-language
 * account, which a small terminal may cut short; `exact` is the command or
 * path itself, which must never be cut, because it is the thing being
 * allowed.
 */
export function approvalCardParts(
  request: ToolApproval,
  width: number,
  colours: Colours = PLAIN,
): { facts: string[]; exact: string[] } {
  const view = approvalView(request);
  const facts = [...wrap(view.headline, width).map((line) => colours.style("bold", line)), ""];
  const rows: Array<[string, string | undefined]> = [
    ["What", view.action],
    ["Why", view.reason],
    ["Scope", view.scope],
    ["Where", view.destination],
    ["Then", view.consequences],
  ];
  const present = rows.flatMap(
    ([label, value]): Array<[string, string]> => (value ? [[label, value]] : []),
  );
  const labelWidth = Math.max(0, ...present.map(([label]) => label.length));
  for (const [label, value] of present)
    facts.push(...labelled(colours, label, value, width, labelWidth));
  const exact: string[] = [];
  if (view.exact) {
    exact.push("");
    // Exactly as it will run: a run of spaces inside a quoted argument is part of the command.
    for (const line of wrapExact(view.exact, width, "  "))
      exact.push(colours.paint("accent2", line));
  }
  if (view.requested) {
    exact.push("");
    for (const line of wrapExact(`worker asked for: ${view.requested}`, width, "  "))
      exact.push(colours.paint("faint", line));
  }
  return { facts, exact };
}

/** What an approval asks, without the frame or the answers: a card's body. */
export function approvalCardBody(
  request: ToolApproval,
  width: number,
  colours: Colours = PLAIN,
): string[] {
  const { facts, exact } = approvalCardParts(request, width, colours);
  return [...facts, ...exact];
}

/** A plan waiting for approval, with its acceptance criteria and tasks. */
export function renderPlan(
  snapshot: ProjectSnapshot,
  width: number,
  colours: Colours = PLAIN,
): string[] {
  const body = planCardBody(snapshot, width, colours);
  if (!body) return [];
  return [
    rule(width, "proposed plan", colours),
    "",
    ...body,
    "",
    `  ${withCommands(colours, "/approve to start    or reply to revise it")}`,
    rule(width, undefined, colours),
  ];
}

/** The unapproved plan's summary, criteria and tasks, or nothing: a card's body. */
export function planCardBody(
  snapshot: ProjectSnapshot,
  width: number,
  colours: Colours = PLAIN,
): string[] | undefined {
  const plan = snapshot.pendingBoard?.plan ?? snapshot.plan;
  if (!plan || plan.approved) return undefined;
  const lines = [...wrap(plan.summary, width)];
  if (plan.acceptanceCriteria?.length) {
    lines.push("", subheading(colours, "Acceptance criteria"));
    lines.push(...bulleted(colours, plan.acceptanceCriteria, width));
  }
  const tasks = snapshot.pendingBoard?.tasks ?? snapshot.tasks;
  if (tasks.length) {
    lines.push("", subheading(colours, "Tasks"));
    tasks.forEach((task, index) => {
      const number = `${index + 1}.`;
      const lead = visibleWidth(`  ${number} `);
      const meta = `${task.difficulty} · ${resolveTaskRoute(task)}`;
      for (const [at, line] of wrap(task.title, Math.max(1, width - lead)).entries())
        lines.push(`${at === 0 ? `  ${colours.paint("faint", number)} ` : indentBy(lead)}${line}`);
      // The size and route sit beside the title when they fit, and under it when they do not.
      const last = lines.length - 1;
      if (visibleWidth(lines[last]) + 2 + visibleWidth(meta) <= width)
        lines[last] = `${lines[last]}  ${colours.paint("faint", meta)}`;
      else lines.push(`${indentBy(lead)}${colours.paint("faint", meta)}`);
    });
  }
  return lines;
}

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
  snapshot: ProjectSnapshot,
  width: number,
  colours: Colours,
): string[] {
  const view = taskStateView(task.status);
  const role = roleForTone(view.tone);
  const attempt = task.attempts.at(-1);
  const titleRole: ColourRole | undefined = view.tone === "muted" ? "ended" : undefined;
  const lines = wrap(task.title, Math.max(1, width - MARK_INDENT.length)).map((line, index) => {
    const mark = index === 0 ? colours.paint(role, `[${TASK_MARK[view.icon]}]`) : "   ";
    return `${mark} ${titleRole ? colours.paint(titleRole, line) : line}`;
  });

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

function renderTasks(snapshot: ProjectSnapshot, width: number, colours: Colours): string[] {
  const tasks = snapshot.tasks;
  if (!tasks.length) return ["No tasks yet. Describe what you want built."];
  const plan = snapshot.pendingBoard?.plan ?? snapshot.plan;
  const lines = heading(
    colours,
    plan?.approved === false ? "Proposed tasks" : "Tasks",
    undefined,
    width,
  );
  lines.push(colours.paint("muted", planProgressEvidence(tasks)), "");
  for (const task of tasks) lines.push(...taskRows(task, snapshot, width, colours), "");
  lines.push(
    ...wrap(
      "[x] means the Project Manager accepted the work. Worker output is evidence; message the manager to change the plan.",
      width,
    ).map((line) => colours.paint("faint", line)),
  );
  return lines;
}

/** The connection as one small phrase for the title bar: a dot, and where to. */
function connectionParts(state: AppStateView, colours: Colours) {
  const { url, tokenConfigured } = state.connection;
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    // Shown as typed.
  }
  if (!url || !tokenConfigured)
    return {
      long: { plain: "○ not connected", styled: colours.paint("review", "○ not connected") },
      short: { plain: "○", styled: colours.paint("review", "○") },
    };
  if (state.probe && !state.probe.ok)
    return {
      long: {
        plain: `○ unreachable · ${host}`,
        styled: colours.paint("fault", `○ unreachable · ${host}`),
      },
      short: { plain: "○ unreachable", styled: colours.paint("fault", "○ unreachable") },
    };
  const role = state.probe?.ok ? "ok" : "unknown";
  return {
    long: { plain: `● ${host}`, styled: colours.paint(role, `● ${host}`) },
    short: { plain: "●", styled: colours.paint(role, "●") },
  };
}

/**
 * The line that names what this is: the project, its state in words and in
 * the desktop app's tone, and whether the controller is reachable. Pinned at
 * the top of every screen, so the answer to "which project, is it working,
 * is Poundlock there" never scrolls away. A rule under it separates it from
 * the screen below.
 */
export function renderTitleBar(
  state: AppStateView,
  width: number,
  colours: Colours = PLAIN,
): string[] {
  const snapshot = state.snapshot;
  const project = snapshot?.project;
  const connection = connectionParts(state, colours);
  const inner = Math.max(1, width - GUTTER * 2);
  let left: string;
  if (!project || !snapshot) {
    left = colours.style("bold", colours.paint("accent", "Poundlock Dispatch"));
  } else {
    const status = projectStatusView(snapshot, { approvals: state.approvals });
    // A decision waiting for you is "needs you" whatever the run is doing; the
    // desktop app's sidebar marks it the same way.
    const waiting = (state.approvals ?? []).some((item) => item.projectId === project.id);
    const tone = waiting ? "review" : projectStatusTone(project.status, status.active);
    const name = colours.style(
      "bold",
      colours.paint("accent", clip(project.name || project.id, Math.max(8, Math.floor(inner / 2)))),
    );
    left = `${name}  ${chip(colours, roleForTone(tone), status.title ?? project.status)}`;
  }
  // The longest phrase for the connection that fits beside the project; a dot alone if only that does.
  const option = [connection.long, connection.short].find(
    (candidate) => visibleWidth(left) + 2 + visibleWidth(candidate.plain) <= inner,
  );
  const line = option ? spread(left, option.styled, inner) : clip(left, inner);
  return [`${indentBy(GUTTER)}${line}`, rule(width, undefined, colours)];
}

/** One line naming what the project is doing and what it needs next. Plain, for a pipe. */
export function renderHeader(
  state: AppStateView,
  status: ProjectStatusView | undefined,
  width: number,
): string[] {
  const project = state.snapshot?.project;
  if (!project) return [rule(width, "no project")];
  const name = project.name || project.id;
  const head = `${name} — ${status?.title ?? project.status}`;
  const lines = [head.length > width ? `${head.slice(0, width - 1)}…` : head];
  if (status?.next) for (const line of wrap(status.next, width)) lines.push(line);
  if (status?.evidence) for (const line of wrap(status.evidence, width)) lines.push(line);
  return lines;
}

/**
 * What to say at the top of the conversation, above the transcript: that
 * Poundlock cannot be reached, if it cannot, or what the run wants next. An
 * empty conversation gets a few lines on how to begin, since a blank screen
 * with a cursor at the bottom teaches nothing.
 */
export function renderBanner(
  state: AppStateView,
  status: ProjectStatusView | undefined,
  width: number,
  colours: Colours = PLAIN,
): string[] {
  const lines: string[] = [];
  const { url, tokenConfigured } = state.connection;
  if (!url || !tokenConfigured) {
    lines.push(
      ...wrap(
        "Not connected to Poundlock. Run /connect to set the controller address and the application token.",
        width,
      ).map((line) => colours.paint("review", line)),
    );
  } else if (state.probe && !state.probe.ok) {
    const reason = state.probe.error ?? "no answer";
    // A command that just failed for the same reason has already said so, below.
    const said = state.notice?.kind === "error" && state.notice.text.includes(reason);
    if (!said)
      lines.push(
        ...wrap(
          `Poundlock is not reachable: ${reason}. /connect checks the address and token.`,
          width,
        ).map((line) => colours.paint("fault", line)),
      );
  }
  const messages = state.snapshot?.messages ?? [];
  // What the run wants next, unless a card on screen is already asking for it.
  if (
    status?.next &&
    !state.approvals?.length &&
    !status.canApprove &&
    !state.snapshot?.project.needsInput
  )
    lines.push(...wrap(status.next, width).map((line) => colours.paint("muted", line)));
  if (!messages.length && state.snapshot) {
    lines.push(
      "",
      colours.paint("faint", "Describe what you want built. Useful commands:"),
      ...[
        ["/setup", "the connection and the models in use"],
        ["/board", "the plan and its tasks"],
        ["/trust", "how worker actions are approved"],
      ].map(
        ([command, what]) =>
          `  ${colours.paint("accent", padTo(command, 8))}${colours.paint("muted", what)}`,
      ),
    );
  }
  return lines;
}

/** The least of what is running that is worth showing next to the progress. */
const MIN_ACTIVITY = 20;

/** A sentence's first sentence, without its full stop: `1 of 3 tasks accepted. Task 2…` becomes `1 of 3 tasks accepted`. */
function firstSentence(text: string): string {
  return (/^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text).replace(/[.!?]$/, "");
}

/**
 * One line for what is happening right now and one for what is doing it,
 * pinned above the composer.
 *
 * Everything here used to live in the scrolling body, so the moment the
 * transcript grew past a screen the run's own state scrolled away — and the
 * budget, which is the reason to watch at all when a frontier model is
 * driving, went with it.
 *
 * Line 1 is what is moving: the activity while a turn or a task is running
 * (with a spinner frame, when the caller has one), and how far along the plan
 * is. Line 2 is what is driving it and what that costs: the manager (with this
 * conversation's reasoning override, when one is set), the worker, and the
 * budget, plus whether this client can act at all. The project and its state
 * are in the title bar above, so neither line repeats them.
 *
 * Each line ranks and drops its own parts independently — a narrow terminal
 * loses the worker's name before it loses the manager's, and the progress
 * before the activity.
 */
export function renderStatusLines(
  state: AppStateView,
  width: number,
  colours: Colours = PLAIN,
  spinner?: string,
  /** False on the board, which shows the same progress under its Tasks heading. */
  showProgress = true,
): [string, string] {
  const project = state.snapshot?.project;
  if (!project) return ["", ""];
  const status = projectStatusView(state.snapshot!, { approvals: state.approvals });
  const manager = state.connection.roles?.manager;
  const worker = state.connection.roles?.interactive;

  const activity = state.busy || state.activity ? state.activity || "working" : undefined;
  const progress = showProgress ? status.evidence : "";
  let line1: string;
  if (activity) {
    const text = spinner ? `${spinner} ${activity}` : activity;
    // The progress stays on the line: in full if it fits beside what is
    // running, else its first sentence (`1 of 3 tasks accepted`), and if even
    // that needs the room, what is running is cut with an ellipsis to make it,
    // down to a floor. It is the one thing on the line that answers "how far
    // along is this", and it used to be dropped first.
    const gap = 2;
    const wordings = [progress, firstSentence(progress)].filter(Boolean);
    const beside =
      wordings.find((words) => visibleWidth(text) + gap + visibleWidth(words) <= width) ??
      wordings.findLast((words) => MIN_ACTIVITY + gap + visibleWidth(words) <= width);
    line1 = beside
      ? spread(
          colours.paint("active", clip(text, width - gap - visibleWidth(beside))),
          colours.paint("faint", beside),
          width,
        )
      : clip(colours.paint("active", text), width);
  } else {
    line1 = clip(colours.paint("muted", progress), width);
  }

  // The manager (and this conversation's reasoning, if overridden) outranks
  // everything else here — it is what the rest of the line explains. A
  // watching client is never a surprise, so it outranks the worker and the
  // budget too.
  const parts: Part[] = [];
  const label = (name: string, value: string) => ({
    text: `${name} ${value}`,
    styled: `${colours.paint("faint", name)} ${value}`,
  });
  if (manager) {
    const reasoning = project.reasoningOverride
      ? ` (${reasoningLabel(project.reasoningOverride)})`
      : "";
    parts.push({
      rank: 0,
      ...label("mgr", `${manager.profileName || manager.profileId}${reasoning}`),
    });
  }
  if (state.watching)
    parts.push({
      rank: 1,
      text: "watching — another client drives",
      styled: colours.paint("review", "watching — another client drives"),
    });
  if (worker) parts.push({ rank: 2, ...label("wrk", worker.profileName || worker.profileId) });
  for (const infolet of visibleComposerInfolets(state))
    parts.push({
      rank: 3,
      text: infolet.text,
      // A context chip that is offering to compact is asking for something.
      styled: colours.paint(infolet.compactOffer ? "review" : "muted", infolet.text),
    });
  const line2 = joinParts(colours, fitParts(parts, width, "  ·  "), width, "  ·  ");
  return [line1, line2];
}

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

/**
 * The conversation as a pipe gets it: the whole product on the happy path. A
 * pending decision replaces the plan and the transcript tail, because it is
 * the only thing the user can usefully act on.
 */
export function renderConversation(state: AppStateView, width: number): Screen {
  const snapshot = state.snapshot;
  if (!snapshot)
    return {
      lines: ["Open a folder to begin.", "", "  poundlock-dispatch-tui <folder>"],
      hint: "No project is open.",
    };
  const status = projectStatusView(snapshot, { approvals: state.approvals });
  const lines = [...renderHeader(state, status, width), ""];

  const pending = (state.approvals ?? []).find(
    (item) => !item.projectId || item.projectId === state.selectedProjectId,
  );
  lines.push(
    ...renderTranscript(
      pending ? snapshot.messages.slice(-4) : snapshot.messages,
      width,
      pending ? undefined : state.managerDraft,
    ),
  );
  lines.push(...renderConversationFooter(state, snapshot, status, width));
  return { lines, hint: renderComposerHint(state, status) };
}

/**
 * The plan and task board, shown in place of the conversation on Tab: the
 * desktop app's Plan and Tasks panels, in the same order, with the same
 * fields under each task.
 */
export function renderBoard(state: AppStateView, width: number, colours: Colours = PLAIN): Screen {
  const snapshot = state.snapshot;
  if (!snapshot) return { lines: ["No project is open."], hint: "" };
  const plan = snapshot.pendingBoard?.plan ?? snapshot.plan;
  const lines: string[] = [];
  const aside = plan ? `Revision ${plan.revision} · ${planApprovalLabel(plan)}` : undefined;
  lines.push(...heading(colours, "Plan", aside, width));
  if (plan) {
    lines.push(...wrap(plan.summary, width), "");
    if (plan.acceptanceCriteria?.length) {
      lines.push(subheading(colours, "Acceptance criteria"));
      lines.push(...bulleted(colours, plan.acceptanceCriteria, width), "");
    }
  } else {
    lines.push(
      colours.paint(
        "muted",
        "Nothing planned yet. Discuss the work in the conversation; the plan and its tasks appear here.",
      ),
      "",
    );
  }
  // The brief the manager keeps pinned in its context, as its own section
  // between the plan and the tasks, where the desktop app's Inspector puts it.
  // It is reference text, so it reads quieter than the plan does.
  if (snapshot.brief) {
    lines.push(
      ...heading(colours, "Project brief", undefined, width),
      ...wrap(snapshot.brief, width).map((line) => colours.paint("muted", line)),
      "",
    );
  }
  lines.push(...renderTasks(snapshot, width, colours));
  return { lines, hint: `[${KEY_HINTS.tasks}] back to the conversation` };
}

/** One row of the setup screen: what it is, and how it stands, in words. */
function setupRow(
  colours: Colours,
  label: string,
  value: string,
  tone: ColourRole | undefined,
  width: number,
): string[] {
  return labelled(colours, label, value, width, 11, tone);
}

/** What still has to be configured before work can start. */
export function renderSetup(state: AppStateView, width: number, colours: Colours = PLAIN): Screen {
  const lines = heading(colours, "Setup", undefined, width);
  const connection = state.connection;
  lines.push(subheading(colours, "Connection"));
  lines.push(
    ...setupRow(
      colours,
      "Controller",
      connection.url || "(not set)",
      connection.url ? undefined : "review",
      width,
    ),
  );
  lines.push(
    ...setupRow(
      colours,
      "Token",
      connection.tokenConfigured ? "configured" : "(not set)",
      connection.tokenConfigured ? "ok" : "review",
      width,
    ),
  );
  lines.push(
    ...setupRow(
      colours,
      "Roles ready",
      connection.rolesReady ? "yes" : "no",
      connection.rolesReady ? "ok" : "review",
      width,
    ),
  );
  if (state.probe) {
    lines.push(
      ...setupRow(
        colours,
        "Reachable",
        state.probe.ok
          ? `yes${state.probe.version ? ` — Poundlock ${state.probe.version}` : ""}`
          : `no — ${state.probe.error ?? "unknown"}`,
        state.probe.ok ? "ok" : "fault",
        width,
      ),
    );
  }

  const bindings = Object.entries(connection.roles ?? {}).filter(([, binding]) => binding);
  lines.push("", subheading(colours, "Models"));
  if (!bindings.length) lines.push(colours.paint("muted", "  No roles are bound to a model yet."));
  const roleWidth = Math.max(11, ...bindings.map(([role]) => role.length));
  const nameWidth = Math.max(
    0,
    ...bindings.map(([, binding]) => (binding?.profileName || binding?.profileId || "").length),
  );
  for (const [role, binding] of bindings) {
    if (!binding) continue;
    const name = binding.profileName || binding.profileId;
    const where = binding.approvedDataDestination
      ? destinationLabel(binding.approvedDataDestination)
      : "";
    lines.push(
      clip(
        `  ${colours.paint("faint", padTo(role, roleWidth))}  ${padTo(name, nameWidth)}${where ? `  ${colours.paint("muted", where)}` : ""}`,
        width,
      ),
    );
  }

  const roots = state.snapshot?.project.policy.roots ?? [];
  lines.push("", subheading(colours, "Extra folders"));
  if (!roots.length)
    lines.push(
      `  ${colours.paint("muted", "none —")} ${withCommands(colours, "/grant <path> [read|write]")}`,
    );
  for (const root of roots)
    lines.push(
      `  ${colours.paint("faint", padTo(root.mode, 6))}${clip(root.path, Math.max(1, width - 8))}`,
    );

  lines.push("", subheading(colours, "Next"));
  // Each sentence its own paragraph, so a command is never split from what it does by a wrap.
  const guidance = [
    ...(!connection.url || !connection.tokenConfigured
      ? ["Run /connect to set the controller address and token, then bind roles here."]
      : connection.rolesReady
        ? [
            "This machine is configured. Settings are shared with the desktop app.",
            "/connect changes the controller or token.",
          ]
        : [
            "Some roles are not bound to a model yet.",
            "/connect changes the controller or token.",
          ]),
    "/models lists what Poundlock is serving; /role <role> <profile> binds one.",
    "If a turn fails because the route changed in Poundlock, run /approve-models.",
  ];
  for (const paragraph of guidance)
    for (const line of wrap(paragraph, Math.max(1, width - 2)))
      lines.push(`  ${withCommands(colours, line)}`);
  return { lines, hint: "/chat to return to the conversation, /quit to exit" };
}
