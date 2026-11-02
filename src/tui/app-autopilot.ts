/**
 * Local auto mode in the terminal client: the folder's newest run followed from
 * its files while this screen is open, its card, and `/autopilot`'s commands.
 * The runner is its own process: this only reads and asks.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { autopilotView } from "@core/auto/control";
import { newestRun } from "@core/auto/runs";
import type { AutopilotStartOptions, AutopilotView } from "@shared/auto-run";
import { autopilotCard, autopilotCardLines } from "@shared/autopilot-card";
import { autopilotStartPreview } from "@shared/autopilot-start";
import { displaySafe } from "@shared/display-safe";
import { type CommandSurface, projectTarget } from "./app-command-surface.js";
import { runAuto } from "./auto.js";
import { splitCommandLine } from "./auto-args.js";
import { autoCardFooter } from "./auto-card.js";
import type { AutoCliDeps } from "./auto-context.js";
import { renderRunDetails } from "./auto-details.js";
import { confirmMerge } from "./auto-merge.js";
import { askStartOptions } from "./auto-start.js";
import type { CardSpec } from "./card.js";
import { wrap } from "./chrome.js";
import { showPicker } from "./picker.js";
import { showPrompt } from "./prompt.js";

export interface AutopilotSurface extends CommandSurface {
  paint(): void;
  /** Open `/autopilot details`' screen. */
  showDetails(): void;
  closing(): boolean;
}

export class AutopilotPanel {
  /** This folder's newest run, and its card while it runs or just ended. */
  private run: string | undefined;
  private lines: string[] | undefined;
  /** The newest run's card and view, shown or hidden: `/autopilot details` reads them. */
  private card: string[] | undefined;
  private view: AutopilotView | undefined;
  /** A run whose card `/autopilot hide` put away; it comes back for the next run. */
  private hidden: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly app: AutopilotSurface,
    /** Local auto mode's commands (ADR 014); without them `/autopilot` is unavailable. */
    private readonly deps?: Omit<AutoCliDeps, "io">,
  ) {}

  start(): void {
    if (!this.deps) return;
    this.timer = setInterval(() => void this.refresh(), 2000);
    void this.refresh();
  }

  /** Leaving this screen only stops following the run. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The run's card, while there is one to show. */
  cardSpec(): CardSpec | undefined {
    const lines = this.lines;
    if (!lines?.length) return undefined;
    return {
      key: `auto:${this.run}`,
      title: "Autopilot",
      role: "accent2",
      // Activity and reasons carry the model's words: nothing in them may drive the terminal.
      body: (inner) => lines.flatMap((line) => wrap(displaySafe(line), inner)),
      maxBodyLines: 8,
      footer: autoCardFooter(this.view?.phase),
    };
  }

  details(width: number): string[] {
    return renderRunDetails(this.card, this.view, width, this.app.colours);
  }

  /** Follow the folder's newest Autopilot run from its files: attached while this screen is open. */
  async refresh(): Promise<void> {
    const folder = this.app.folder();
    if (!this.deps || !folder || this.app.closing()) return;
    const runDir = await newestRun(this.deps.paths, folder).catch(() => undefined);
    const view = runDir
      ? await autopilotView(this.deps.paths, folder).catch(() => undefined)
      : undefined;
    const state = this.app.state();
    const card = view
      ? autopilotCardLines(
          autopilotCard(
            view,
            state?.snapshot?.plan?.requirements ?? [],
            new Date(),
            state?.snapshot?.managerUsd,
            state?.weekUsd,
          ),
        )
      : undefined;
    let lines: string[] | undefined;
    if (runDir && runDir !== this.hidden && view) {
      const status = await stat(join(runDir, "status.json")).catch(() => undefined);
      const recent = !status || Date.now() - status.mtimeMs < 30 * 60_000;
      lines = view.phase !== "ended" || recent ? card : undefined;
    }
    if (this.app.closing()) return;
    if (
      runDir === this.run &&
      JSON.stringify([view, card, lines]) === JSON.stringify([this.view, this.card, this.lines])
    )
      return;
    this.run = runDir;
    this.view = view;
    this.card = card;
    this.lines = lines;
    this.app.paint();
  }

  /**
   * `/autopilot` takes the shell command's words, for this folder. It starts a
   * run without waiting (the card shows its checks), `hide` puts the card away
   * and `watch` brings it back. The runner itself never runs inside this screen.
   */
  async command(input: string): Promise<void> {
    const folder = this.app.folder();
    if (!folder) throw new Error("Open a folder first: an Autopilot run works on one repository.");
    // The guided start goes through the host, as the app's dialog does.
    if (/^\/\S+\s+start\s*$/.test(input.trim())) return this.guidedStart();
    if (!this.deps) throw new Error("Local auto mode is not available in this client.");
    // `/autopilot message <words>`: the words as typed, apostrophes and all, to this folder's run.
    const words = /^\/\S+\s+message\s+(?!--)(.+)$/s.exec(input.trim())?.[1];
    if (words) return this.runArgv(["message", "--text", words, "--dir", folder]);
    const [command = "status", ...rest] = splitCommandLine(input).slice(1);
    if (command === "hide") {
      this.hidden = this.run;
      this.lines = undefined;
      this.app.paint();
      return;
    }
    if (command === "details") {
      await this.refresh();
      this.app.showDetails();
      return;
    }
    if (command === "watch" || command === "attach") {
      this.hidden = undefined;
      await this.refresh();
      return;
    }
    if (command === "run")
      throw new Error("The runner starts from /autopilot start or /autopilot resume.");
    if (command === "merge" && !rest.includes("--yes")) {
      const runDir = await newestRun(this.deps.paths, folder);
      if (!runDir) throw new Error("This folder has no Autopilot run.");
      if (await confirmMerge(this.app.tui, this.app.colours, runDir))
        await this.runArgv(["merge", "--yes", "--dir", folder]);
      return;
    }
    const argv = [command, ...rest];
    const named = rest.length > 0 && !rest[0].startsWith("-");
    const hasDir = rest.some((word) => word === "--dir" || word.startsWith("--dir="));
    if (!hasDir && (command === "start" || command === "list" || !named))
      argv.push("--dir", folder);
    if (command === "start" && !rest.includes("--no-wait")) argv.push("--no-wait");
    await this.runArgv(argv);
  }

  /**
   * `/autopilot start` with nothing after it: the app's "Build with Autopilot"
   * dialog as questions, started through the host as the app starts it, so a
   * pending plan is approved and confirmed checks become the project's.
   */
  private async guidedStart(): Promise<void> {
    const { host, tui, colours } = this.app;
    // The Planner's consent and spend cap depend on where it sends code, which
    // only the catalog Poundlock serves now can say.
    await host.refreshServerInfo();
    const state = await host.getState();
    if (!state.snapshot) throw new Error("Open a project first.");
    const preview = autopilotStartPreview(state, state.snapshot);
    // Nothing is working while a question waits for the owner.
    this.app.setWorking(undefined);
    this.app.setPrompting(true);
    let options: AutopilotStartOptions | undefined;
    try {
      options = await askStartOptions(preview, {
        text: (title, detail, initial) => showPrompt(tui, colours, { title, detail, initial }),
        choose: async (title, items) => (await showPicker(tui, colours, items, { title }))?.value,
      });
    } finally {
      this.app.setPrompting(false);
    }
    if (!options) return;
    this.app.setWorking("Starting Autopilot: checking the image and the VM");
    try {
      await host.autopilotStart(options, projectTarget(this.app));
    } finally {
      this.app.setWorking(undefined);
    }
    this.hidden = undefined;
    await host.emitState();
    await this.refresh();
  }

  /** Run one `dispatch autopilot` command for this screen; what it says becomes the notice. */
  private async runArgv(argv: string[]): Promise<void> {
    if (!this.deps) throw new Error("Local auto mode is not available in this client.");
    const said: string[] = [];
    const code = await runAuto(argv, {
      ...this.deps,
      io: { out: (text) => said.push(text), err: (text) => said.push(text) },
    });
    this.hidden = undefined;
    this.app.host.setNotice({ kind: code === 0 ? "info" : "error", text: said.join("").trim() });
    await this.app.host.emitState();
    await this.refresh();
  }
}
