/** The approval and plan cards, as lines. */

import { visibleWidth } from "@earendil-works/pi-tui";
import { approvalView } from "@shared/approval-view";
import { type ToolApproval } from "@shared/permissions";
import { type ProjectSnapshot, resolveTaskRoute } from "@shared/types";
import { indentBy, labelled, rule, wrap, wrapExact } from "./chrome.js";
import { type Colours, PLAIN } from "./colour.js";
import { bulleted, KEY_HINTS, subheading, withCommands } from "./render-text.js";

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
