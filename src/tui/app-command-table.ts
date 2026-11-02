/**
 * What each slash command does, one entry per `CommandDef` in the same order.
 * A screen switch paints itself directly (nothing else would); an action goes
 * through `run`, which already repaints via the state it changes or the notice
 * it sets on failure.
 */

import type { TranscriptDensity } from "@shared/live-work-view";
import type { RunHistoryRecord } from "@shared/types";
import { type CommandSurface, projectTarget } from "./app-command-surface.js";
import { approveModels, connect, listModels, setRole } from "./app-model-commands.js";
import {
  checks,
  fixRounds,
  grant,
  network,
  projectModel,
  readGrant,
  repoAccount,
  requireProject,
  runtime,
  trust,
  webSearch,
} from "./app-project-commands.js";
import {
  accounts,
  appearance,
  ladder,
  localManager,
  permissions,
  reasoning,
} from "./app-settings-commands.js";
import type { ScreenId } from "./app-views.js";
import { commandHelp, isTranscriptDensity, TRANSCRIPT_DENSITY } from "./commands.js";
import { type ConfirmedProjectAction, confirmProjectAction } from "./lifecycle.js";
import { pickTask } from "./task-evidence.js";

export interface CommandTableSurface extends CommandSurface {
  /** Run one host action, showing a refusal rather than throwing it. */
  run(work: () => Promise<unknown>, label?: string): Promise<void>;
  showScreen(id: ScreenId): void;
  showHistory(records: RunHistoryRecord[]): void;
  showTask(taskId: string, attempt?: number): void;
  density(): TranscriptDensity;
  setDensity(density: TranscriptDensity): void;
  autopilot(input: string): Promise<void>;
  /** The task the current status offers to retry, if any. */
  retryableTask(): string | undefined;
  /** Close this client, saying `said` on the way out. */
  quit(said?: string): Promise<void>;
}

type Handler = (input: string) => Promise<void>;

export function commandTable(app: CommandTableSurface): Map<string, Handler> {
  const { host } = app;
  /** `/new` and `/new-run`, confirmed in a picker as the app's Project menu confirms them. */
  const projectAction = async (id: ConfirmedProjectAction) =>
    confirmProjectAction(id, { ...app, state: await host.getState() });
  /**
   * `/archive` and `/remove`. This screen is bound to its folder, so once the
   * project is gone it closes and says what happened; opening the folder again
   * starts a new project.
   */
  const leaveProject = async (id: "archive" | "remove") => {
    if (await projectAction(id)) await app.quit((await host.getState()).notice?.text);
  };
  const target = () => projectTarget(app);
  const screen = (id: ScreenId) => async () => app.showScreen(id);
  /** A command whose work takes the typed line, with an optional label while it runs. */
  const act =
    (work: (surface: CommandSurface, input: string) => Promise<unknown>, label?: string) =>
    async (input: string) =>
      app.run(() => work(app, input), label);
  return new Map<string, Handler>([
    [
      "/help",
      async () => {
        host.setNotice({ kind: "info", text: commandHelp() });
        await host.emitState();
      },
    ],
    ["/board", screen("board")],
    ["/setup", screen("setup")],
    ["/connect", act(connect)],
    ["/chat", screen("conversation")],
    [
      "/history",
      async () =>
        app.run(async () => {
          app.showHistory(await host.runHistory(target()));
        }),
    ],
    [
      "/compact",
      async (input) => {
        const instructions = input.slice("/compact".length).trim();
        await app.run(
          () => host.compactConversation(instructions || undefined, target()),
          "Compacting the conversation…",
        );
      },
    ],
    ["/approve", async () => app.run(() => host.approvePlan(target()))],
    ["/new", async () => app.run(() => projectAction("newConversation"))],
    ["/new-run", async () => app.run(() => projectAction("newRun"))],
    [
      "/task",
      async (input) =>
        app.run(async () => {
          const tasks = app.state()?.snapshot?.tasks ?? [];
          const { task, attempt } = pickTask(tasks, input.trim().replace(/^\S+/, ""));
          app.showTask(task.id, attempt?.number);
        }),
    ],
    ["/archive", async () => app.run(() => leaveProject("archive"))],
    ["/remove", async () => app.run(() => leaveProject("remove"))],
    ["/approve-models", act(approveModels, "Asking Poundlock for the current route…")],
    ["/models", act(listModels, "Asking Poundlock for its models…")],
    ["/role", act(setRole, "Checking with Poundlock…")],
    ["/reasoning", act(reasoning)],
    ["/transcript", async (input) => app.run(() => transcriptDensity(app, input))],
    ["/trust", act(trust)],
    ["/network", act(network)],
    ["/checks", act(checks)],
    ["/fix-rounds", act(fixRounds)],
    ["/runtime", act(runtime)],
    ["/repo-account", act(repoAccount)],
    ["/permissions", act(permissions)],
    ["/ladder", act(ladder)],
    ["/local-manager", act(localManager)],
    ["/accounts", act(accounts)],
    ["/appearance", act(appearance)],
    ["/websearch", act(webSearch)],
    ["/project-model", act(projectModel, "Checking with Poundlock…")],
    ["/autopilot", async (input) => app.run(() => app.autopilot(input), "Autopilot…")],
    ["/auto", async (input) => app.run(() => app.autopilot(input), "Autopilot…")],
    ["/grant", act(grant)],
    [
      "/revoke",
      async (input) => {
        const [, path] = input.split(/\s+/);
        await app.run(async () => {
          if (!path) throw new Error("Name the folder to stop using.");
          await host.revokeRoot(requireProject(app), path);
        });
      },
    ],
    ["/grant-file", act((surface, input) => readGrant(surface, input, "grant"))],
    ["/revoke-file", act((surface, input) => readGrant(surface, input, "revoke"))],
    ["/pause", async () => app.run(() => host.pauseRun(target()))],
    ["/cancel", async () => app.run(() => host.cancelRun(target()))],
    ["/resume", async () => app.run(() => host.startRun(target()))],
    ["/reopen", async () => app.run(() => host.reopenRun(target()))],
    [
      "/override",
      async (input) => {
        const reason = input.slice("/override".length).trim();
        await app.run(async () => {
          if (!reason) throw new Error("Say why: /override <reason>.");
          await host.overrideRun(reason, target());
        });
      },
    ],
    [
      "/retry",
      async (input) => {
        const [, named] = input.split(/\s+/);
        await app.run(async () => {
          const taskId = named ?? app.retryableTask();
          if (!taskId) throw new Error("No task is waiting for a retry.");
          await host.retryTask(taskId, target());
        });
      },
    ],
    ["/quit", async () => app.quit()],
  ]);
}

/** `/transcript [normal|verbose]`: how much of the work the conversation shows, remembered here. */
async function transcriptDensity(app: CommandTableSurface, input: string): Promise<void> {
  const [, wanted] = input.trim().split(/\s+/);
  if (wanted !== undefined && !isTranscriptDensity(wanted))
    throw new Error("Usage: /transcript [normal|verbose]");
  if (wanted && wanted !== app.density()) {
    await app.preferences.write({ ...(await app.preferences.read()), transcriptDensity: wanted });
    app.setDensity(wanted);
  }
  app.host.setNotice({ kind: "info", text: `Transcript: ${TRANSCRIPT_DENSITY[app.density()]}` });
  await app.host.emitState();
}
