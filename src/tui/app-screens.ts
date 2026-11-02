/**
 * The scrolling body and the title bar above it: which screen is showing, and
 * each screen's view, drawn from state to the width it actually gets.
 */

import {
  type Component,
  Container,
  isViewportTUI,
  ScrollView,
  type TUI,
  VStack,
} from "@earendil-works/pi-tui";
import type { TranscriptDensity } from "@shared/live-work-view";
import { fixRoundsPerTask } from "@shared/policy-limits";
import { projectStatusView } from "@shared/project-status";
import type { AppStateView, RunHistoryRecord } from "@shared/types";
import { LineView, proseColumn, type ScreenId, TranscriptComponent } from "./app-views.js";
import { GUTTER, gutter } from "./chrome.js";
import type { Colours } from "./colour.js";
import { renderHistory } from "./history.js";
import { markdownTheme } from "./markdown-theme.js";
import { renderBanner, renderBoard, renderNotices, renderSetup, renderTitleBar } from "./render.js";
import { renderTaskEvidence } from "./task-evidence.js";
import { TranscriptView } from "./transcript.js";

export interface ScreensContext {
  state(): AppStateView | undefined;
  colours: Colours;
  /** `/autopilot details`, at this width. */
  runDetails(width: number): string[];
}

export class Screens {
  current: ScreenId = "conversation";
  /** The screen the body last showed, so a change of screen can reset where it is scrolled to. */
  private shown: ScreenId = "conversation";
  readonly body = new Container();
  /** The scrolling region around `body`, once the layout exists (a stub terminal has none). */
  private scroller: ScrollView | undefined;
  /** The project, its state and whether Poundlock is reachable: pinned above every screen. */
  readonly titleBar: LineView;
  /** What to know before reading on: not connected, or how to begin. Above the transcript. */
  private readonly banner: LineView;
  /** The componentised transcript: one row per message, keyed by id. */
  private readonly transcript: TranscriptView;
  private readonly transcriptComponent: TranscriptComponent;
  /** Dispatch's own last word: the notice and anything recovery waits on. Below the transcript. */
  private readonly notices: LineView;
  private readonly views: Record<Exclude<ScreenId, "conversation">, LineView>;
  /** The task `/task` opened, by id, and the attempt by number; read afresh at each paint. */
  private taskShown: { taskId: string; attempt?: number } | undefined;
  /** What `/history` read, shown until the next `/history`. */
  private history: RunHistoryRecord[] = [];

  constructor(private readonly context: ScreensContext) {
    const { state, colours } = context;
    this.transcript = new TranscriptView(markdownTheme(colours), colours);
    this.transcriptComponent = new TranscriptComponent(this.transcript);
    this.titleBar = new LineView((width) => {
      const now = state();
      return now ? renderTitleBar(now, width, colours) : [];
    });
    this.banner = new LineView((width) => {
      const now = state();
      if (!now) return [];
      if (!now.snapshot) return gutter(["Open a folder to begin.", "", "  dispatch <folder>", ""]);
      const status = projectStatusView(now.snapshot, { approvals: now.approvals });
      const lines = renderBanner(now, status, proseColumn(width), colours);
      return lines.length ? [...gutter(lines), ""] : [];
    });
    this.notices = new LineView((width) => {
      const now = state();
      const lines = now ? renderNotices(now, proseColumn(width), colours) : [];
      return lines.length ? ["", ...gutter(lines)] : [];
    });
    /** A screen's lines inside the margins on both sides. */
    const framed = (lines: (inner: number) => string[]) =>
      new LineView((width) => gutter(lines(Math.max(1, width - GUTTER * 2))));
    this.views = {
      board: framed((inner) => {
        const now = state();
        return now ? renderBoard(now, inner, colours).lines : [];
      }),
      setup: framed((inner) => {
        const now = state();
        return now ? renderSetup(now, inner, colours).lines : [];
      }),
      history: framed((inner) => renderHistory(this.history, inner, colours)),
      run: framed((inner) => context.runDetails(inner)),
      task: framed((inner) => this.renderTask(inner)),
    };
  }

  /** Lay the screens out on the terminal, with `bottom` pinned under them. */
  attach(tui: TUI, bottom: Component[]): void {
    if (!isViewportTUI(tui)) {
      for (const component of [this.titleBar, this.body, ...bottom]) tui.addChild(component);
      return;
    }
    tui.setLayoutRoot(
      new VStack([
        { component: this.titleBar, basis: "auto", shrink: 0 },
        { component: this.scrolling(), basis: 0, grow: 1, minSize: 1 },
        { component: new VStack(bottom), basis: "auto", shrink: 1, minSize: 5 },
      ]),
    );
  }

  /** The body inside a scroll view, for a terminal that lays out a viewport. */
  private scrolling(): ScrollView {
    const { colours } = this.context;
    this.scroller = new ScrollView(this.body, {
      follow: "end",
      primary: true,
      scrollbarTrackStyle: (text) => colours.paint("line", text),
      scrollbarThumbStyle: (text) => colours.paint("faint", text),
    });
    return this.scroller;
  }

  showHistory(records: RunHistoryRecord[]): void {
    this.history = records;
    this.current = "history";
  }

  showTask(taskId: string, attempt?: number): void {
    this.taskShown = { taskId, attempt };
    this.current = "task";
  }

  /**
   * Put the current screen in the body. With a decision pending, the
   * transcript shows just enough of the conversation for context.
   */
  paint(state: AppStateView, density: TranscriptDensity, pending: boolean): void {
    // The conversation follows its end; the board and setup are read from the
    // top. Without this the board opened scrolled to its last line, with the
    // plan above the fold.
    if (this.current !== this.shown) {
      this.shown = this.current;
      if (this.current === "conversation") this.scroller?.scrollToEnd();
      // `disableFollow`: the last screen may have been short enough that its
      // top was also its end, which would leave the board following its own end.
      else this.scroller?.scrollTo(0, { disableFollow: true });
    }
    this.body.clear();
    if (this.current !== "conversation") {
      this.body.addChild(this.views[this.current]);
      return;
    }
    const snapshot = state.snapshot;
    if (snapshot) {
      // A turn does not stream while an approval is open, so there is no
      // reply-in-progress to show then either.
      if (pending) this.transcript.sync(snapshot.messages.slice(-4), undefined, density);
      else
        this.transcript.sync(snapshot.messages, state.managerDraft, density, {
          entries: state.liveWork,
          activity: state.activity,
        });
    }
    this.body.addChild(this.banner);
    this.body.addChild(this.transcriptComponent);
    this.body.addChild(this.notices);
  }

  /** The task `/task` opened, as it stands now. */
  private renderTask(width: number): string[] {
    const state = this.context.state();
    const snapshot = state?.snapshot;
    const task = snapshot?.tasks.find((item) => item.id === this.taskShown?.taskId);
    if (!state || !snapshot || !task)
      return ["That task is no longer on the board. /chat to return."];
    const attempt =
      task.attempts.find((item) => item.number === this.taskShown?.attempt) ?? task.attempts.at(-1);
    const rounds = fixRoundsPerTask(
      snapshot.project.policy.fixRoundsPerTask,
      state.permissions.fixRoundsPerTask,
    );
    return renderTaskEvidence({ task, attempt }, rounds, width, this.context.colours);
  }
}
