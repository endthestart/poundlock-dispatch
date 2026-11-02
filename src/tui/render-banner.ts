/** The title bar, the project header and the banner that says what the project is doing. */

import { visibleWidth } from "@earendil-works/pi-tui";
import { autopilotOwnsStatus } from "@shared/autopilot-card";
import { type ProjectStatusView, projectStatusView } from "@shared/project-status";
import { CARD_TONES, projectGlance, projectStatusTone } from "@shared/status-tone";
import { type AppStateView } from "@shared/types";
import { chip, clip, GUTTER, indentBy, padTo, rule, spread, wrap } from "./chrome.js";
import { type Colours, PLAIN, roleForTone } from "./colour.js";

/** Connected, but without the manager and worker every conversation needs. */
function modelsMissing(state: AppStateView): boolean {
  const { url, tokenConfigured, rolesReady } = state.connection;
  return Boolean(url && tokenConfigured && !rolesReady);
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
    // While Autopilot's run is the project's latest work, its state is the project's state.
    const glance = projectGlance(project, state.autopilotGlances);
    left = glance
      ? `${name}  ${chip(colours, roleForTone(CARD_TONES[glance.tone]), glance.label)}`
      : modelsMissing(state)
        ? `${name}  ${chip(colours, "review", "Choose models")}`
        : `${name}  ${chip(colours, roleForTone(tone), status.title ?? project.status)}`;
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
  if (modelsMissing(state))
    lines.push(
      ...wrap(
        "No manager or worker is chosen yet. /role manager and /role worker choose them from what /models lists.",
        width,
      ).map((line) => colours.paint("review", line)),
    );
  const messages = state.snapshot?.messages ?? [];
  // What the run wants next, unless a card on screen is already asking for it.
  if (
    status?.next &&
    !modelsMissing(state) &&
    !autopilotOwnsStatus(state.autopilot, status.cause) &&
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
