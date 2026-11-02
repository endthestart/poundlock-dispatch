/** The status lines under the composer: activity, the manager and the worker in use. */

import { visibleWidth } from "@earendil-works/pi-tui";
import { autopilotOwnsStatus } from "@shared/autopilot-card";
import { projectStatusView } from "@shared/project-status";
import { reasoningLabel } from "@shared/reasoning";
import { managerChoice, projectWorkerRoles } from "@shared/roles";
import { visibleComposerInfolets } from "@shared/status-infolets";
import { type AppStateView, type ProjectSnapshot } from "@shared/types";
import { clip, fitParts, joinParts, type Part, spread } from "./chrome.js";
import { type Colours, PLAIN } from "./colour.js";

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
/** Why the manager is the model it is, in the desktop app's words for its manager line. */
const MANAGER_ORIGIN = {
  project: "project override",
  local: "this computer",
  fallback: "local fallback after a spending limit",
  escalation: "model ladder",
} as const;

/** The manager this project's next turn uses: a run's own choice, else the project's, else the default. */
function managerInUse(
  state: AppStateView,
  project: ProjectSnapshot["project"],
): { name: string; origin: "default" | keyof typeof MANAGER_ORIGIN } | undefined {
  const active =
    state.managerSelection?.projectId === project.id ? state.managerSelection : undefined;
  if (active) return { name: active.name, origin: active.origin };
  const roles = state.connection.roles ?? {};
  const choice = managerChoice(project, roles);
  if (choice.origin !== "default") return { name: choice.fallbackName, origin: choice.origin };
  const binding = roles.manager;
  return binding
    ? { name: binding.profileName || binding.profileId, origin: "default" }
    : undefined;
}

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
  const manager = managerInUse(state, project);
  // This project's own worker when it has one, as the run uses it; named as /models lists it.
  const worker = projectWorkerRoles(state.connection.roles ?? {}, project.policy).interactive;
  const workerName =
    worker &&
    (state.probe?.interactiveModels?.find(
      (model) => model.profileId === worker.profileId || model.id === worker.profileId,
    )?.id ??
      (worker.profileName || worker.profileId));

  const activity = state.busy || state.activity ? state.activity || "working" : undefined;
  // While Autopilot owns the project its card says how far along it is; the app hides this too.
  const progress =
    showProgress && !autopilotOwnsStatus(state.autopilot, status.cause) ? status.evidence : "";
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
    const notes = [
      ...(manager.origin === "default" ? [] : [MANAGER_ORIGIN[manager.origin]]),
      ...(project.reasoningOverride ? [reasoningLabel(project.reasoningOverride)] : []),
    ];
    parts.push({
      rank: 0,
      ...label("mgr", `${manager.name}${notes.length ? ` (${notes.join(", ")})` : ""}`),
    });
  }
  if (state.watching)
    parts.push({
      rank: 1,
      text: "watching — another client drives",
      styled: colours.paint("review", "watching — another client drives"),
    });
  if (workerName) parts.push({ rank: 2, ...label("wrk", workerName) });
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
