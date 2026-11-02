/**
 * `dispatch autopilot status` and `watch` lead with the run card the app and
 * the terminal client show: standing, time and spend, a verdict per
 * requirement, what needs you and what was built. Its details follow. Only
 * the folder's newest run has a card, as in the app.
 */
import { autopilotView } from "@core/auto/control";
import type { AutoPaths } from "@core/auto/runs";
import { readRunFile } from "@core/auto/runs";
import { ManagerSpend } from "@core/manager-spend";
import { projectFiles } from "@core/paths";
import type { FileStore } from "@core/store";
import { WeekSpend } from "@core/week-spend";
import type { AutopilotView } from "@shared/auto-run";
import { autopilotCard, autopilotCardLines } from "@shared/autopilot-card";
import type { ProjectRecord } from "@shared/types";

export interface RunCardDeps {
  paths: AutoPaths;
  project(source: string): Promise<{ project: ProjectRecord; store: FileStore } | undefined>;
}

/** Spend is summed from session and event files; one reader per command keeps them cached. */
export function runCardReader(deps: RunCardDeps) {
  const manager = new ManagerSpend();
  const week = new WeekSpend();
  return async (
    runDir: string,
    now = new Date(),
  ): Promise<{ card: string[]; view: AutopilotView } | undefined> => {
    const run = await readRunFile(runDir);
    const view = await autopilotView(deps.paths, run.source, now);
    if (view?.runId !== run.runId) return undefined;
    const found = await deps.project(run.source);
    if (!found) return { card: autopilotCardLines(autopilotCard(view, [], now)), view };
    const { project, store } = found;
    const root = store.layout.root;
    const sessions = (await store.listProjects()).map(
      (item) => projectFiles(root, item.id).sessions,
    );
    const card = autopilotCardLines(
      autopilotCard(
        view,
        (await store.getPlan(project.id))?.requirements ?? [],
        now,
        await manager.of(projectFiles(root, project.id).sessions),
        await week.total(sessions, deps.paths.runs, now),
      ),
    );
    return { card, view };
  };
}

/** The commands under the card that fit where the run is: a live run is stopped, an ended one merged. */
export function autoCardFooter(phase: AutopilotView["phase"] | undefined): string {
  // One line under the card: the command once, then what it takes.
  const commands = (names: string[]) => `/autopilot ${names.join(" · ")}`;
  if (phase === "interrupted")
    return `type to message it · ${commands(["details", "resume", "export", "hide"])}`;
  if (phase === "ended") return commands(["details", "merge", "export", "report", "drop", "hide"]);
  return `${phase ? "type to message it · " : ""}${commands(["details", "stop", "stop --now", "hide"])} · runs on after you quit`;
}
