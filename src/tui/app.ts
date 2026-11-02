import { describeReach, projectReach } from "@shared/network";
/**
 * Painting and keys.
 *
 * Everything this file knows is how to put `render.ts`'s lines on a terminal
 * and turn keystrokes into `DispatchHost` calls. It holds no workflow rules of
 * its own: which actions are offered, whether the composer may send, and what
 * a decision says are all decided upstream and shared with the desktop app.
 *
 * The screen is drawn from state at render time, not built when state
 * arrives: every view here is handed the width it will actually get, so a
 * resize, or a scrollbar taking a column, re-lays the text instead of
 * re-wrapping lines that were already wrapped for a different terminal.
 */

import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { autopilotView } from "@core/auto/control";
import { newestRun } from "@core/auto/runs";
import type { DispatchHost } from "@core/host/dispatch-host";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  isViewportTUI,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  type SelectItem,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { approvalView } from "@shared/approval-view";
import type { AutopilotStartOptions, AutopilotView } from "@shared/auto-run";
import { autopilotCard, autopilotCardLines, autopilotOwnsStatus } from "@shared/autopilot-card";
import { autopilotStartPreview } from "@shared/autopilot-start";
import type { TranscriptDensity } from "@shared/live-work-view";
import {
  effectiveToolTrust,
  TOOL_TRUST_MODES,
  type ToolTrustMode,
  toolTrustLabel,
} from "@shared/permissions";
import { fixRoundsPerTask } from "@shared/policy-limits";
import { projectStatusView } from "@shared/project-status";
import { conversationReasoningView, isReasoningChoice, reasoningLabel } from "@shared/reasoning";
import type { ExecutionRole, RoleBinding, RoleMap } from "@shared/roles";
import {
  bindingForProfile,
  catalogFromProbe,
  EXECUTION_ROLES,
  guessRoleMap,
  roleUnavailableReason,
} from "@shared/roles";
import { compactOffered } from "@shared/status-infolets";
import { type AppStateView, EXAMPLE_CONTROLLER_URL, type RunHistoryRecord } from "@shared/types";
import { accountLines, parseAccounts, TOKEN_HINT } from "./accounts.js";
import { permissionsCommand } from "./app-permissions.js";
import { appearanceLines, parseAppearance } from "./appearance.js";
import { type AutoCliDeps, runAuto, splitCommandLine } from "./auto.js";
import { autoCardFooter } from "./auto-card.js";
import { renderRunDetails } from "./auto-details.js";
import { confirmMerge } from "./auto-merge.js";
import { askStartOptions } from "./auto-start.js";
import { BoxedEditor } from "./boxed-editor.js";
import { Card, type CardSpec } from "./card.js";
import { checksCommand } from "./checks.js";
import { fitSentence, GUTTER, gutter, type KeyHint, keyHints, rule } from "./chrome.js";
import { type ColourRole, type Colours, resolveColours } from "./colour.js";
import {
  COMMAND_DEFS,
  isTranscriptDensity,
  NETWORK_CHOICES,
  TRANSCRIPT_DENSITY,
  toSlashCommands,
} from "./commands.js";
import { connectController } from "./connect.js";
import { fixRoundsCommand } from "./fix-rounds.js";
import { renderHistory } from "./history.js";
import { displaySafe } from "./jobs.js";
import { ladderCommand } from "./ladder.js";
import { type ConfirmedProjectAction, confirmProjectAction } from "./lifecycle.js";
import {
  localManagerLines,
  localManagerOff,
  localManagerSettings,
  parseLocalManager,
} from "./local-manager.js";
import { ensureHighlightTheme, markdownTheme } from "./markdown-theme.js";
import {
  DESTINATION_USAGE,
  destinationOverride,
  modelDetailLines,
  modelListRows,
} from "./model-detail.js";
import { showPicker } from "./picker.js";
import { memoryPreferences, type TuiPreferenceStore } from "./preferences.js";
import {
  repoAccountChoice,
  repoAccountLine,
  runtimeChoice,
  runtimeLines,
} from "./project-access.js";
import { matchProfile, projectModelCommand } from "./project-model.js";
import { showPrompt } from "./prompt.js";
import {
  actionHints,
  approvalCardParts,
  composerHint,
  needsInputTitle,
  planCardBody,
  renderBanner,
  renderBoard,
  renderNotices,
  renderSetup,
  renderStatusLines,
  renderTitleBar,
  wrap,
} from "./render.js";
import { pickTask, renderTaskEvidence } from "./task-evidence.js";
import { TranscriptView } from "./transcript.js";
import { WEB_SEARCH_USAGE, webSearchCommand } from "./web-search.js";

type ScreenId = "conversation" | "board" | "setup" | "history" | "run" | "task";

/** Ctrl+R first: it arrives unchanged in every terminal. See `defaultTui`. */
export const SEARCH_KEYS = ["ctrl+r", "ctrl+shift+f"] as const;

/**
 * The composer's border says whether it is the thing to type into: the accent
 * while it has the keyboard, and the quiet line colour while a card holds it
 * or the composer is refusing to send until a decision is made.
 */
function editorTheme(colours: Colours, border: () => ColourRole) {
  return {
    borderColor: (value: string) => colours.paint(border(), value),
    selectList: {
      selectedPrefix: (value: string) => colours.paint("accent", `> ${value}`),
      selectedText: (value: string) => colours.style("bold", colours.paint("accent", value)),
      description: (value: string) => colours.paint("faint", value),
      scrollInfo: (value: string) => colours.paint("faint", value),
      noMatch: (value: string) => colours.paint("faint", value),
    },
  };
}

/** How long a first Ctrl+C stays armed. Long enough to mean it, short enough not to accumulate. */
const QUIT_CONFIRM_MS = 3000;

/** How long a one-line message (an unknown command, a cleared draft) stays where the keys are. */
const FLASH_MS = 4000;

/** Rows the chrome always takes: title bar (2), status (2), composer box (3) and its keys (1). */
const CHROME_ROWS = 8;

/** Braille frames, the same set pi's own loader uses. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;

/**
 * The widest a paragraph or a code fence gets before it wraps, even on a very
 * wide terminal. The chrome around it — the title bar, the status lines, the
 * composer's box — still spans the full terminal width; only prose is
 * capped, because a paragraph stretched across 200 columns reads worse than
 * one left flush at a comfortable width with room to spare.
 */
const PROSE_CAP = 100;

/** A component whose lines are made when it is drawn, from the width it is drawn at. */
class LineView implements Component {
  constructor(private readonly build: (width: number) => string[]) {}

  render(width: number): string[] {
    return this.build(width);
  }

  invalidate(): void {}
}

/** The column prose is set in: capped, and inside the screen's left margin. */
function proseColumn(width: number): number {
  return Math.max(1, Math.min(width, PROSE_CAP) - GUTTER);
}

/** A component that renders `TranscriptView` in the prose column, not full width. */
class TranscriptComponent implements Component {
  constructor(private readonly view: TranscriptView) {}

  render(width: number): string[] {
    return gutter(this.view.render(proseColumn(width)));
  }

  invalidate(): void {
    this.view.invalidate();
  }
}

/**
 * The default terminal for a real run (tests inject a stub instead). Search
 * is themed from the same Catppuccin roles as everything else, and copying a
 * selection goes through pi-coding-agent's `copyToClipboard` rather than the
 * OSC 52 write `TuiAltScreen` falls back to, which not every terminal (or
 * multiplexer) passes through.
 *
 * Search is Ctrl+R, as in a shell, because it arrives unchanged in every
 * terminal. Ctrl+Shift+F needs the Kitty keyboard protocol, which iTerm2
 * does not speak by default, and Ctrl+/ arrives there as the same byte as
 * Ctrl+-, which is the editor's Undo.
 */
function defaultTui(): TuiAltScreen {
  const colours = resolveColours();
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": [...SEARCH_KEYS] }),
  );
  return new TuiAltScreen(new ProcessTerminal(), true, undefined, {
    mouse: true,
    copySelection: async (text) => {
      try {
        await copyToClipboard(text);
        return true;
      } catch {
        return false;
      }
    },
    searchMatchStyle: (text) => colours.paint("accent2", text),
    searchCurrentMatchStyle: (text) => colours.paint("accent", text),
    searchNavigationButtonStyle: (text, hovered) =>
      hovered ? colours.paint("accent", text) : text,
  });
}

export class TuiApp {
  private screen: ScreenId = "conversation";
  private state: AppStateView | undefined;
  private readonly body = new Container();
  /** The scrolling region around `body`, once the layout exists (a stub terminal has none). */
  private scroller: ScrollView | undefined;
  /** The screen the body last showed, so a change of screen can reset where it is scrolled to. */
  private shownScreen: ScreenId = "conversation";
  /** The project, its state and whether Poundlock is reachable: pinned above every screen. */
  private readonly titleBar: LineView;
  /** What to know before reading on: not connected, or how to begin. Above the transcript. */
  private readonly banner: LineView;
  /** The componentised transcript: one row per message, keyed by id. */
  private readonly transcript: TranscriptView;
  private readonly transcriptComponent: TranscriptComponent;
  /** Dispatch's own last word: the notice and anything recovery waits on. Below the transcript. */
  private readonly notices: LineView;
  /** The board and setup screens, drawn to the width they get. */
  private readonly boardView: LineView;
  private readonly setupView: LineView;
  private readonly historyView: LineView;
  private readonly runView: LineView;
  private readonly taskView: LineView;
  /** The task `/task` opened, by id, and the attempt by number; read afresh at each paint. */
  private taskShown: { taskId: string; attempt?: number } | undefined;
  /** What `/history` read, shown until the next `/history`. */
  private history: RunHistoryRecord[] = [];
  /**
   * The plan, approval and question cards, pinned above the status lines so
   * they stay in view while the conversation scrolls. Kept by key across
   * paints: a card is rebuilt only when its decision changes, so the answer
   * highlighted in it survives a state update.
   */
  private readonly cardSlot = new Container();
  private cards = new Map<string, Card>();
  /** Where keys go: the composer, or the card with answers to choose. */
  private focusOn: "composer" | "card" = "composer";
  /** The card focus last moved for; focus moves on its own only for a new one. */
  private announcedCard: string | undefined;
  /** Separates the scrolling transcript from the pinned bottom, when no card does. */
  private readonly divider: LineView;
  /** Pinned above the composer, so what the run is doing never scrolls away. */
  private readonly statusLines: LineView;
  /** Set by a first Ctrl+C; a second one within this window exits. */
  private quitArmedAt = 0;
  /** A question overlay (`/connect`) is open: every key belongs to it, none is a shortcut. */
  private prompting = false;
  /** The composer as drawn: a box around the editor. Focus and input go here. */
  private readonly composer: BoxedEditor;
  private readonly editor: Editor;
  private stopState: (() => void) | undefined;
  private closing = false;
  /** Resolved once at startup: the saved theme, this terminal's colour depth, NO_COLOR/TTY. */
  private readonly colours: Colours;
  /** Keyed by name (with the leading "/"); built once, since every entry only closes over `this`. */
  private readonly commands: Map<string, (input: string) => Promise<void>>;
  /** A short message in place of the key hints, until `flashUntil`. */
  private flash: { text: string; role: ColourRole } | undefined;
  private flashUntil = 0;
  /** What a slow command is doing, shown as activity until it finishes. */
  private working: string | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerFrame = 0;
  /** Whether the composer is refusing to send, which dims its border. */
  private composerBlocked = false;
  /** Local auto mode: this folder's newest run, and its card while it runs or just ended. */
  private autoRun: string | undefined;
  private autoLines: string[] | undefined;
  /** The newest run's card and view, shown or hidden: `/auto details` reads them. */
  private autoCard: string[] | undefined;
  private autoView: AutopilotView | undefined;
  private autoPhase: AutopilotView["phase"] | undefined;
  /** A run whose card `/auto hide` put away; it comes back for the next run. */
  private autoHidden: string | undefined;
  private autoTimer: ReturnType<typeof setInterval> | undefined;
  /** How much of the work the transcript shows: `/transcript`, remembered on this computer. */
  private density: TranscriptDensity = "normal";

  constructor(
    private readonly host: DispatchHost,
    private readonly tui: TUI = defaultTui(),
    private readonly exit: (code: number) => void = (code) => process.exit(code),
    colours: Colours = resolveColours(),
    /** Local auto mode's commands (ADR 014); without them `/auto` is unavailable. */
    private readonly autoDeps?: Omit<AutoCliDeps, "io">,
    private readonly preferences: TuiPreferenceStore = memoryPreferences(),
  ) {
    this.colours = colours;
    // pi-coding-agent keeps its syntax-highlight theme in module state; this
    // has to run before anything below builds a `MarkdownTheme` or renders a
    // code fence. See `markdown-theme.ts`.
    ensureHighlightTheme(colours);
    this.transcript = new TranscriptView(markdownTheme(colours), colours);
    this.transcriptComponent = new TranscriptComponent(this.transcript);
    const border = (): ColourRole =>
      this.focusOn === "composer" && !this.composerBlocked ? "accent" : "line";
    this.composer = new BoxedEditor(this.tui, editorTheme(colours, border), (text) =>
      colours.paint(border(), text),
    );
    this.composer.setFooter((inner) => this.footer(inner));
    this.editor = this.composer.editor;
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };

    this.titleBar = new LineView((width) =>
      this.state ? renderTitleBar(this.state, width, colours) : [],
    );
    this.banner = new LineView((width) => {
      const state = this.state;
      if (!state) return [];
      const column = proseColumn(width);
      if (!state.snapshot)
        return gutter(["Open a folder to begin.", "", "  poundlock-dispatch-tui <folder>", ""]);
      const status = projectStatusView(state.snapshot, { approvals: state.approvals });
      const lines = renderBanner(state, status, column, colours);
      return lines.length ? [...gutter(lines), ""] : [];
    });
    this.notices = new LineView((width) => {
      const lines = this.state ? renderNotices(this.state, proseColumn(width), colours) : [];
      return lines.length ? ["", ...gutter(lines)] : [];
    });
    this.boardView = new LineView((width) =>
      this.state
        ? gutter(renderBoard(this.state, Math.max(1, width - GUTTER * 2), colours).lines)
        : [],
    );
    this.setupView = new LineView((width) =>
      this.state
        ? gutter(renderSetup(this.state, Math.max(1, width - GUTTER * 2), colours).lines)
        : [],
    );
    this.historyView = new LineView((width) =>
      gutter(renderHistory(this.history, Math.max(1, width - GUTTER * 2), colours)),
    );
    this.runView = new LineView((width) =>
      gutter(
        renderRunDetails(this.autoCard, this.autoView, Math.max(1, width - GUTTER * 2), colours),
      ),
    );
    this.taskView = new LineView((width) =>
      gutter(this.renderTask(Math.max(1, width - GUTTER * 2))),
    );
    this.divider = new LineView((width) =>
      this.cards.size ? [] : [rule(width, undefined, colours)],
    );
    this.statusLines = new LineView((width) => {
      if (!this.state) return ["", ""];
      // A slow command's own label stands in for the activity the host has not reported.
      const state = this.working
        ? { ...this.state, busy: true, activity: this.state.activity ?? this.working }
        : this.state;
      const active = Boolean(state.busy || state.activity);
      const [one, two] = renderStatusLines(
        state,
        Math.max(1, width - GUTTER * 2),
        colours,
        active ? SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] : undefined,
        this.screen !== "board",
      );
      return gutter([one, two]).map((line) => line || " ");
    });
    this.commands = this.buildCommands();
  }

  async start(): Promise<void> {
    if (isViewportTUI(this.tui)) {
      const colours = this.colours;
      this.scroller = new ScrollView(this.body, {
        follow: "end",
        primary: true,
        scrollbarTrackStyle: (text) => colours.paint("line", text),
        scrollbarThumbStyle: (text) => colours.paint("faint", text),
      });
      this.tui.setLayoutRoot(
        new VStack([
          { component: this.titleBar, basis: "auto", shrink: 0 },
          {
            component: this.scroller,
            basis: 0,
            grow: 1,
            minSize: 1,
          },
          {
            component: new VStack([this.cardSlot, this.divider, this.statusLines, this.composer]),
            basis: "auto",
            shrink: 1,
            minSize: 5,
          },
        ]),
      );
    } else {
      this.tui.addChild(this.titleBar);
      this.tui.addChild(this.body);
      this.tui.addChild(this.cardSlot);
      this.tui.addChild(this.divider);
      this.tui.addChild(this.statusLines);
      this.tui.addChild(this.composer);
    }
    // `body`'s children depend on the screen and are assembled in `paint`,
    // which the end of `start` already calls once state has loaded.
    this.tui.setFocus(this.composer);
    // Decide synchronously whether this key is a shortcut, so a consumed key
    // never also reaches the editor and appears as typed text.
    this.tui.addInputListener((data) => {
      const action = this.shortcut(data);
      if (!action) return undefined;
      void this.run(action);
      return { consume: true };
    });
    this.stopState = this.host.onState((state) => {
      this.state = state;
      this.paint();
    });
    this.state = await this.host.getState();
    try {
      this.density = (await this.preferences.read()).transcriptDensity;
    } catch (error) {
      this.host.setNotice({
        kind: "error",
        text: `Could not read this client's saved settings, so the transcript is Normal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // Up and Down in the composer walk back through what you have sent, as
    // Pi does when it resumes a session. The editor keeps newest first.
    for (const message of this.state.snapshot?.messages ?? [])
      if (message.role === "user") this.editor.addToHistory(message.text);
    // "/" completes with a description, and "@" completes a path relative to
    // the project's own folder — the one piece of custom autocomplete code
    // this needed is the command list itself (`commands.ts`); the rest is
    // pi-tui's own `CombinedAutocompleteProvider`.
    const project = this.state.snapshot?.project;
    const basePath =
      project?.source.kind === "local_folder" ? project.source.originalPath : process.cwd();
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(toSlashCommands(COMMAND_DEFS), basePath),
    );
    this.paint();
    this.tui.start();
    if (this.autoDeps) {
      this.autoTimer = setInterval(() => void this.refreshAuto(), 2000);
      void this.refreshAuto();
    }
    // First run: ask for the controller and token now, rather than leave a
    // screen that cannot do anything until someone finds the desktop app.
    if (!this.state.connection.url || !this.state.connection.tokenConfigured)
      void this.run(() => this.connect("/connect"));
    // Otherwise read what Poundlock serves, so models are named rather than shown by id.
    else
      void this.host
        .refreshServerInfo()
        .then(() => this.host.emitState())
        .catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.stopState?.();
    this.stopSpinner();
    // The runner is its own process: leaving this screen only stops following it.
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.tui.stop();
    await this.host.shutdown();
  }

  /**
   * The whole screen as lines at `width`, top to bottom, the way the terminal
   * would show it if it were tall enough. For tests: nothing else asks a
   * component tree what it looks like.
   */
  renderForTest(width: number): string[] {
    return [
      ...this.titleBar.render(width),
      ...this.body.render(width),
      ...this.cardSlot.render(width),
      ...this.divider.render(width),
      ...this.statusLines.render(width),
      ...this.composer.render(width),
    ];
  }

  /** Redraw from the current state: which views are showing, which card has the keys, what the composer says. */
  private paint(): void {
    if (!this.state) return;
    const state = this.state;
    const snapshot = state.snapshot;

    // The conversation follows its end; the board and setup are read from the
    // top. Without this the board opened scrolled to its last line, with the
    // plan above the fold.
    if (this.screen !== this.shownScreen) {
      this.shownScreen = this.screen;
      if (this.screen === "conversation") this.scroller?.scrollToEnd();
      // `disableFollow`: the last screen may have been short enough that its
      // top was also its end, which would leave the board following its own end.
      else this.scroller?.scrollTo(0, { disableFollow: true });
    }
    this.body.clear();
    if (this.screen === "board") this.body.addChild(this.boardView);
    else if (this.screen === "setup") this.body.addChild(this.setupView);
    else if (this.screen === "history") this.body.addChild(this.historyView);
    else if (this.screen === "run") this.body.addChild(this.runView);
    else if (this.screen === "task") this.body.addChild(this.taskView);
    else {
      if (snapshot) {
        const pending = this.pendingDecision();
        // A pending decision is the only thing left to act on, so the
        // transcript shows just enough of it for context, and its own
        // reply-in-progress (there cannot be one — a turn does not stream
        // while an approval is open) is never shown either.
        if (pending) this.transcript.sync(snapshot.messages.slice(-4), undefined, this.density);
        else
          this.transcript.sync(snapshot.messages, state.managerDraft, this.density, {
            entries: state.liveWork,
            activity: state.activity,
          });
      }
      this.body.addChild(this.banner);
      this.body.addChild(this.transcriptComponent);
      this.body.addChild(this.notices);
    }
    this.syncCards(this.screen === "conversation" ? this.cardSpecs() : []);
    this.syncSpinner();
    this.applyFocus();

    // What the composer will do, or why it will not, set into its border.
    const status = snapshot
      ? projectStatusView(snapshot, { approvals: state.approvals })
      : undefined;
    const hint = composerHint(state, status);
    this.composerBlocked = hint.blocked;
    this.composer.setTitle((room) =>
      this.colours.paint(hint.blocked ? "review" : "muted", fitSentence(hint.text, room)),
    );
    this.tui.requestRender();
  }

  /** The keys that do something right now, with the ones this state calls for first. */
  private hints(): KeyHint[] {
    if (this.focusOn === "card")
      return [
        { key: "Esc", label: "type a message" },
        { key: "Tab", label: "board" },
        { key: "Ctrl+C", label: "exit" },
      ];
    const scroll: KeyHint = { key: "PgUp/PgDn", label: "scroll" };
    const search: KeyHint = { key: "Ctrl+R", label: "search" };
    const exit: KeyHint = { key: "Ctrl+C", label: "exit" };
    if (this.screen === "board")
      return [
        { key: "Tab", label: "back to chat" },
        { key: "/", label: "commands" },
        scroll,
        search,
        exit,
      ];
    if (["setup", "history", "run", "task"].includes(this.screen))
      return [
        { key: "/chat", label: "back to chat" },
        ...(this.screen === "setup" ? [{ key: "/connect", label: "connection" }] : []),
        { key: "/", label: "commands" },
        scroll,
        exit,
      ];
    const snapshot = this.state?.snapshot;
    const status = snapshot
      ? projectStatusView(snapshot, { approvals: this.state?.approvals })
      : undefined;
    return [
      ...(this.choosableCard() ? [{ key: "Tab", label: "answer the card" }] : []),
      ...(status && !autopilotOwnsStatus(this.state?.autopilot, status.cause)
        ? actionHints(status.actions)
        : []),
      ...(this.state && compactOffered(this.state)
        ? [{ key: "/compact", label: "free up context" }]
        : []),
      { key: "Enter", label: "send" },
      { key: "/", label: "commands" },
      ...(this.choosableCard() ? [] : [{ key: "Tab", label: "board" }]),
      search,
      scroll,
      exit,
    ];
  }

  /** The line under the composer: a passing message if there is one, else the keys. */
  private footer(inner: number): string {
    if (this.flash && Date.now() < this.flashUntil)
      return this.colours.paint(this.flash.role, this.flash.text);
    return keyHints(this.colours, this.hints(), inner);
  }

  /** Say something short in the key line, for a few seconds. */
  private say(text: string, role: ColourRole, ms = FLASH_MS): void {
    this.flash = { text, role };
    this.flashUntil = Date.now() + ms;
    this.tui.requestRender();
    setTimeout(() => this.tui.requestRender(), ms + 50).unref();
  }

  /** Animate the spinner while anything is running, and only then. */
  private syncSpinner(): void {
    const state = this.state;
    const active = Boolean(state && (state.busy || state.activity || this.working));
    if (!active) {
      this.stopSpinner();
      return;
    }
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame += 1;
      this.tui.requestRender();
    }, SPINNER_MS);
    this.spinnerTimer.unref();
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  /**
   * The most rows a card may take: what is left after the title bar, the
   * status, the composer and its keys, and `keep` lines of conversation to
   * leave in view. A card never grows past this, so the composer is never
   * pushed off the bottom.
   */
  private cardRoom(keep: number): number {
    const rows = process.stdout.rows || 30;
    return Math.max(8, Math.min(24, rows - CHROME_ROWS - keep));
  }

  /** The cards the current state calls for, newest decision nearest the composer. */
  private cardSpecs(): CardSpec[] {
    const state = this.state;
    const snapshot = state?.snapshot;
    if (!state || !snapshot) return [];
    const colours = this.colours;
    const pending = this.pendingDecision();
    if (pending) {
      const view = approvalView(pending);
      return [
        {
          key: `approval:${pending.id}`,
          title: "Decision needed",
          role: "review",
          body: (inner) => approvalCardParts(pending, inner, colours).facts,
          pinned: (inner) => approvalCardParts(pending, inner, colours).exact,
          // While one is open the conversation is only context, so the request
          // gets almost all the screen.
          maxHeight: this.cardRoom(2),
          choices: {
            items: [
              { value: "once", label: view.once, description: "[a]" },
              { value: "always", label: view.remember, description: "[s]" },
              { value: "deny", label: view.deny, description: "[d]" },
            ],
            onSelect: (item) =>
              void this.run(() => this.host.decideApproval(pending.id, item.value)),
            onCancel: () => this.toComposer(),
          },
          footer: (inner) =>
            keyHints(
              colours,
              [
                { key: "↑↓", label: "choose" },
                { key: "Enter", label: "confirm" },
                { key: "a/s/d", label: "answer now" },
                { key: "Esc", label: "type instead" },
              ],
              inner,
            ),
        },
      ];
    }
    const specs: CardSpec[] = [];
    const room = this.cardRoom(5);
    if (planCardBody(snapshot, 80)) {
      specs.push({
        key: `plan:${snapshot.project.planRevision}`,
        title: "Proposed plan",
        role: "accent",
        body: (inner) => planCardBody(snapshot, inner, colours) ?? [],
        maxHeight: room,
        overflow: "/board for the full plan",
        footer: (inner) =>
          keyHints(
            colours,
            [
              { key: "/approve", label: "to start" },
              { key: "reply", label: "to revise" },
            ],
            inner,
          ),
      });
    }
    const needsInput = snapshot.project.needsInput;
    if (needsInput) {
      // Dispatch's own decisions and a manager question's options both arrive
      // as choices. A question can still be answered in words: Esc goes to the
      // message box, and free text is sent as the answer.
      const choices = needsInput.choices ?? [];
      const decision = choices.length > 0;
      const ownWords = needsInput.kind === "question";
      specs.push({
        key: `question:${needsInput.askedAt}`,
        title: needsInputTitle(needsInput),
        role: decision ? "review" : "accent2",
        body: (inner) => wrap(needsInput.question, inner),
        maxHeight: room,
        choices: decision
          ? {
              items: choices.map((choice) => ({
                value: choice.id,
                label: choice.description
                  ? `${choice.label} — ${choice.description}`
                  : choice.label,
              })),
              onSelect: (item) =>
                void this.run(() => this.host.replyInput(item.value, this.target())),
              onCancel: () => this.toComposer(),
            }
          : undefined,
        footer: (inner) =>
          decision
            ? keyHints(
                colours,
                [
                  { key: "↑↓", label: "choose" },
                  { key: "Enter", label: "confirm" },
                  { key: "Esc", label: ownWords ? "reply in your own words" : "message box" },
                ],
                inner,
              )
            : "Reply in the message box below.",
      });
    }
    if (this.autoLines?.length) {
      const lines = this.autoLines;
      specs.push({
        key: `auto:${this.autoRun}`,
        title: "Autopilot",
        role: "accent2",
        // Activity and reasons carry the model's words: nothing in them may drive the terminal.
        body: (inner) => lines.flatMap((line) => wrap(displaySafe(line), inner)),
        maxBodyLines: 8,
        footer: autoCardFooter(this.autoPhase),
      });
    }
    return specs;
  }

  /** The folder this screen has open, when it is a local folder. */
  private folder(): string | undefined {
    const project = this.state?.snapshot?.project;
    return project?.source.kind === "local_folder" ? project.source.originalPath : undefined;
  }

  /** Follow the folder's newest auto run from its files: attached while this screen is open. */
  private async refreshAuto(): Promise<void> {
    const folder = this.folder();
    if (!this.autoDeps || !folder || this.closing) return;
    const runDir = await newestRun(this.autoDeps.paths, folder).catch(() => undefined);
    const view = runDir
      ? await autopilotView(this.autoDeps.paths, folder).catch(() => undefined)
      : undefined;
    const card = view
      ? autopilotCardLines(
          autopilotCard(
            view,
            this.state?.snapshot?.plan?.requirements ?? [],
            new Date(),
            this.state?.snapshot?.managerUsd,
            this.state?.weekUsd,
          ),
        )
      : undefined;
    let lines: string[] | undefined;
    if (runDir && runDir !== this.autoHidden && view) {
      const status = await stat(join(runDir, "status.json")).catch(() => undefined);
      const recent = !status || Date.now() - status.mtimeMs < 30 * 60_000;
      lines = view.phase !== "ended" || recent ? card : undefined;
    }
    if (this.closing) return;
    if (
      runDir === this.autoRun &&
      JSON.stringify([view, card, lines]) ===
        JSON.stringify([this.autoView, this.autoCard, this.autoLines])
    )
      return;
    this.autoRun = runDir;
    this.autoPhase = view?.phase;
    this.autoView = view;
    this.autoCard = card;
    this.autoLines = lines;
    this.paint();
  }

  /**
   * `/auto` takes the shell command's words, for this folder. It starts a run
   * without waiting (the card shows its checks), `hide` puts the card away and
   * `watch` brings it back. The runner itself never runs inside this screen.
   */
  private async auto(input: string): Promise<void> {
    const folder = this.folder();
    if (!folder) throw new Error("Open a folder first: an auto run works on one repository.");
    // The guided start goes through the host, as the app's dialog does.
    if (/^\/\S+\s+start\s*$/.test(input.trim())) return this.guidedStart();
    if (!this.autoDeps) throw new Error("Local auto mode is not available in this client.");
    // `/auto message <words>`: the words as typed, apostrophes and all, to this folder's run.
    const words = /^\/\S+\s+message\s+(?!--)(.+)$/s.exec(input.trim())?.[1];
    if (words) return this.runAutoArgv(["message", "--text", words, "--dir", folder]);
    const [command = "status", ...rest] = splitCommandLine(input).slice(1);
    if (command === "hide") {
      this.autoHidden = this.autoRun;
      this.autoLines = undefined;
      this.paint();
      return;
    }
    if (command === "details") {
      await this.refreshAuto();
      this.screen = "run";
      this.paint();
      return;
    }
    if (command === "watch" || command === "attach") {
      this.autoHidden = undefined;
      await this.refreshAuto();
      return;
    }
    if (command === "run") throw new Error("The runner starts from /auto start or /auto resume.");
    if (command === "merge" && !rest.includes("--yes")) {
      const runDir = await newestRun(this.autoDeps.paths, folder);
      if (!runDir) throw new Error("This folder has no Autopilot run.");
      if (await confirmMerge(this.tui, this.colours, runDir))
        await this.runAutoArgv(["merge", "--yes", "--dir", folder]);
      return;
    }
    const argv = [command, ...rest];
    const named = rest.length > 0 && !rest[0].startsWith("-");
    const hasDir = rest.some((word) => word === "--dir" || word.startsWith("--dir="));
    if (!hasDir && (command === "start" || command === "list" || !named))
      argv.push("--dir", folder);
    if (command === "start" && !rest.includes("--no-wait")) argv.push("--no-wait");
    await this.runAutoArgv(argv);
  }

  /** Run one `dispatch autopilot` command for this screen; what it says becomes the notice. */
  /**
   * `/autopilot start` with nothing after it: the app's "Build with Autopilot"
   * dialog as questions, started through the host as the app starts it, so a
   * pending plan is approved and confirmed checks become the project's.
   */
  private async guidedStart(): Promise<void> {
    // The Planner's consent and spend cap depend on where it sends code, which
    // only the catalog Poundlock serves now can say.
    await this.host.refreshServerInfo();
    const state = await this.host.getState();
    if (!state.snapshot) throw new Error("Open a project first.");
    const preview = autopilotStartPreview(state, state.snapshot);
    // Nothing is working while a question waits for the owner.
    this.working = undefined;
    this.paint();
    this.prompting = true;
    let options: AutopilotStartOptions | undefined;
    try {
      options = await askStartOptions(preview, {
        text: (title, detail, initial) =>
          showPrompt(this.tui, this.colours, { title, detail, initial }),
        choose: async (title, items) =>
          (await showPicker(this.tui, this.colours, items, { title }))?.value,
      });
    } finally {
      this.prompting = false;
    }
    if (!options) return;
    this.working = "Starting Autopilot: checking the image and the VM";
    this.paint();
    try {
      await this.host.autopilotStart(options, this.target());
    } finally {
      this.working = undefined;
    }
    this.autoHidden = undefined;
    await this.host.emitState();
    await this.refreshAuto();
  }

  private async runAutoArgv(argv: string[]): Promise<void> {
    if (!this.autoDeps) throw new Error("Local auto mode is not available in this client.");
    const said: string[] = [];
    const code = await runAuto(argv, {
      ...this.autoDeps,
      io: { out: (text) => said.push(text), err: (text) => said.push(text) },
    });
    this.autoHidden = undefined;
    this.host.setNotice({ kind: code === 0 ? "info" : "error", text: said.join("").trim() });
    await this.host.emitState();
    await this.refreshAuto();
  }

  /** Keep a card object per decision; rebuild the slot's order to match. */
  private syncCards(specs: CardSpec[]): void {
    const next = new Map<string, Card>();
    for (const spec of specs) {
      const existing = this.cards.get(spec.key);
      if (existing) existing.update(spec);
      next.set(spec.key, existing ?? new Card(spec, this.colours));
    }
    this.cards = next;
    this.cardSlot.clear();
    for (const card of next.values()) this.cardSlot.addChild(card);
  }

  /** The card that can take the keyboard: the last with answers to choose. */
  private choosableCard(): Card | undefined {
    return [...this.cards.values()].filter((card) => card.choosable).at(-1);
  }

  /**
   * Move the keyboard only when a new decision appears, and then only if
   * nothing is half-typed: a card that shows up mid-sentence must not take
   * the next Enter. Tab moves to it from there.
   */
  private applyFocus(): void {
    const card = this.choosableCard();
    if (!card) {
      this.focusOn = "composer";
      this.announcedCard = undefined;
    } else if (card.key !== this.announcedCard) {
      this.announcedCard = card.key;
      if (!this.editor.getText().trim()) this.focusOn = "card";
    }
    this.tui.setFocus(this.focusOn === "card" && card ? card : this.composer);
  }

  private toComposer(): void {
    this.focusOn = "composer";
    this.tui.setFocus(this.composer);
    this.tui.requestRender();
  }

  /**
   * The action a keystroke means right now, or nothing if it is ordinary
   * typing.
   *
   * Only two kinds of key are ever a shortcut. Keys that cannot be typed into
   * a sentence — Ctrl+C, Tab — always act. Letters act only while a decision
   * is pending, and a pending decision already blocks the composer, so there
   * is nothing legitimate to type at that moment; the editor is unfocused too.
   * Everything else is a slash command, because an input listener runs before
   * the editor and a letter shortcut would otherwise swallow the first
   * character of a word — typing "always" would have answered a decision.
   */
  shortcut(data: string): (() => Promise<unknown>) | undefined {
    if (this.prompting) return undefined;
    if (matchesKey(data, "ctrl+c"))
      return async () => {
        // Never exit on one keystroke. Ctrl+C first abandons what you were
        // typing; only a second press, while nothing is left to abandon,
        // leaves — and only within a short window, so a stray Ctrl+C minutes
        // ago cannot combine with one now to end the session.
        if (this.editor.getText().trim().length) {
          this.editor.setText("");
          this.quitArmedAt = 0;
          this.say("Cleared. Ctrl+C again to exit.", "review", QUIT_CONFIRM_MS);
          return;
        }
        const now = Date.now();
        if (now - this.quitArmedAt <= QUIT_CONFIRM_MS) {
          await this.stop();
          this.exit(0);
          return;
        }
        this.quitArmedAt = now;
        this.say("Ctrl+C again to exit.", "review", QUIT_CONFIRM_MS);
      };
    if (matchesKey(data, "tab")) {
      // From the composer, Tab goes to a card waiting for an answer; with
      // none, it switches between the conversation and the board.
      if (this.focusOn === "composer" && this.screen === "conversation" && this.choosableCard())
        return async () => {
          this.focusOn = "card";
          this.applyFocus();
          this.tui.requestRender();
        };
      return async () => {
        this.screen = this.screen === "board" ? "conversation" : "board";
        this.paint();
      };
    }
    // The letters answer only while the approval card has the keyboard, so
    // a card that appears mid-sentence never turns a typed letter into a
    // decision.
    const pending = this.pendingDecision();
    if (!pending || this.focusOn !== "card") return undefined;
    const decision = { a: "once", s: "always", d: "deny" }[data];
    return decision ? () => this.host.decideApproval(pending.id, decision) : undefined;
  }

  /** The task the current status offers to retry, if any. */
  private retryableTask(): string | undefined {
    const snapshot = this.state?.snapshot;
    if (!snapshot) return undefined;
    const status = projectStatusView(snapshot, { approvals: this.state?.approvals });
    return status.actions.find((action) => action.id === "retry_task")?.taskId;
  }

  /** The decision this client must answer before anything else can happen. */
  private pendingDecision() {
    const state = this.state;
    if (!state) return undefined;
    return (state.approvals ?? []).find(
      (item) => !item.projectId || item.projectId === state.selectedProjectId,
    );
  }

  private target() {
    return this.state?.selectedProjectId ? { projectId: this.state.selectedProjectId } : undefined;
  }

  /** The composer, so a test can put a half-written message in it. */
  editorForTest(): Editor {
    return this.editor;
  }

  /** Which screen is showing, for tests. */
  screenForTest(): ScreenId {
    return this.screen;
  }

  /** Submit as if the user pressed Enter. Exposed for tests; the editor calls `submit`. */
  submitForTest(text: string): Promise<void> {
    return this.submit(text);
  }

  private async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    this.editor.setText("");
    if (!trimmed) return;
    // `/connect <address> <more>` may be a token pasted where it does not
    // belong; it stays out of the up-arrow history.
    if (!/^\/connect\s+\S+\s+\S/.test(trimmed)) this.editor.addToHistory(trimmed);
    if (trimmed.startsWith("/")) {
      await this.command(trimmed);
      return;
    }
    // The reply lands in the transcript, so a message sent from the setup or
    // board screen brings the conversation back rather than arriving unseen.
    if (this.screen !== "conversation") {
      this.screen = "conversation";
      this.paint();
    }
    const needsInput = this.state?.snapshot?.project.needsInput;
    if (!needsInput) {
      await this.run(() => this.host.sendMessage(trimmed, this.target()));
      return;
    }
    // A bare number picks that choice; anything else is a free-text answer.
    const choices = needsInput.choices ?? [];
    const index = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
    const choice = index >= 1 && index <= choices.length ? choices[index - 1].id : trimmed;
    await this.run(() => this.host.replyInput(choice, this.target()));
  }

  /**
   * One entry per `CommandDef`, in the same order, each closing over `this`
   * for the one thing `commands.ts` cannot have. A screen switch paints
   * itself directly (nothing else would); an action goes through `run`,
   * which already repaints via the state it changes or the notice it sets on
   * failure.
   */
  private buildCommands(): Map<string, (input: string) => Promise<void>> {
    const screen = (id: ScreenId) => async () => {
      this.screen = id;
      this.paint();
    };
    return new Map<string, (input: string) => Promise<void>>([
      ["/board", screen("board")],
      ["/setup", screen("setup")],
      ["/connect", async (input) => this.run(() => this.connect(input))],
      ["/chat", screen("conversation")],
      [
        "/history",
        async () =>
          this.run(async () => {
            this.history = await this.host.runHistory(this.target());
            await screen("history")();
          }),
      ],
      [
        "/compact",
        async (input) => {
          const instructions = input.slice("/compact".length).trim();
          await this.run(
            () => this.host.compactConversation(instructions || undefined, this.target()),
            "Compacting the conversation…",
          );
        },
      ],
      ["/approve", async () => this.run(() => this.host.approvePlan(this.target()))],
      ["/new", async () => this.run(() => this.projectAction("newConversation"))],
      ["/new-run", async () => this.run(() => this.projectAction("newRun"))],
      [
        "/task",
        async (input) =>
          this.run(async () => {
            const tasks = this.state?.snapshot?.tasks ?? [];
            const { task, attempt } = pickTask(tasks, input.trim().replace(/^\S+/, ""));
            this.taskShown = { taskId: task.id, attempt: attempt?.number };
            await screen("task")();
          }),
      ],
      ["/archive", async () => this.run(() => this.leaveProject("archive"))],
      ["/remove", async () => this.run(() => this.leaveProject("remove"))],
      [
        "/approve-models",
        async () => this.run(() => this.approveModels(), "Asking Poundlock for the current route…"),
      ],
      [
        "/models",
        async (input) => this.run(() => this.listModels(input), "Asking Poundlock for its models…"),
      ],
      ["/role", async (input) => this.run(() => this.setRole(input), "Checking with Poundlock…")],
      ["/reasoning", async (input) => this.run(() => this.reasoning(input))],
      ["/transcript", async (input) => this.run(() => this.transcriptDensity(input))],
      ["/trust", async (input) => this.run(() => this.trust(input))],
      ["/network", async (input) => this.run(() => this.network(input))],
      ["/checks", async (input) => this.run(() => this.checks(input))],
      ["/fix-rounds", async (input) => this.run(() => this.fixRounds(input))],
      ["/runtime", async (input) => this.run(() => this.runtime(input))],
      ["/repo-account", async (input) => this.run(() => this.repoAccount(input))],
      ["/permissions", async (input) => this.run(() => this.permissions(input))],
      ["/ladder", async (input) => this.run(() => this.ladder(input))],
      ["/local-manager", async (input) => this.run(() => this.localManager(input))],
      ["/accounts", async (input) => this.run(() => this.accounts(input))],
      ["/appearance", async (input) => this.run(() => this.appearance(input))],
      ["/websearch", async (input) => this.run(() => this.webSearch(input))],
      [
        "/project-model",
        async (input) => this.run(() => this.projectModel(input), "Checking with Poundlock…"),
      ],
      ["/autopilot", async (input) => this.run(() => this.auto(input), "Autopilot…")],
      ["/auto", async (input) => this.run(() => this.auto(input), "Autopilot…")],
      ["/grant", async (input) => this.run(() => this.grant(input))],
      [
        "/revoke",
        async (input) => {
          const [, path] = input.split(/\s+/);
          await this.run(async () => {
            if (!path) throw new Error("Name the folder to stop using.");
            await this.host.revokeRoot(this.requireProject(), path);
          });
        },
      ],
      ["/grant-file", async (input) => this.run(() => this.readGrant(input, "grant"))],
      ["/revoke-file", async (input) => this.run(() => this.readGrant(input, "revoke"))],
      ["/pause", async () => this.run(() => this.host.pauseRun(this.target()))],
      ["/cancel", async () => this.run(() => this.host.cancelRun(this.target()))],
      ["/resume", async () => this.run(() => this.host.startRun(this.target()))],
      ["/reopen", async () => this.run(() => this.host.reopenRun(this.target()))],
      [
        "/override",
        async (input) => {
          const reason = input.slice("/override".length).trim();
          await this.run(async () => {
            if (!reason) throw new Error("Say why: /override <reason>.");
            await this.host.overrideRun(reason, this.target());
          });
        },
      ],
      [
        "/retry",
        async (input) => {
          const [, named] = input.split(/\s+/);
          await this.run(async () => {
            const taskId = named ?? this.retryableTask();
            if (!taskId) throw new Error("No task is waiting for a retry.");
            await this.host.retryTask(taskId, this.target());
          });
        },
      ],
      [
        "/quit",
        async () => {
          await this.stop();
          this.exit(0);
        },
      ],
    ]);
  }

  private async command(input: string): Promise<void> {
    const [name] = input.split(/\s+/);
    const run = this.commands.get(name);
    if (!run) {
      this.say(`Unknown command ${name}. Type / to see the commands.`, "fault");
      return;
    }
    await run(input);
  }

  /**
   * Set the controller address and token, as the desktop app's setup does. The
   * token is asked for hidden and is never a command argument, where it would
   * sit in the composer's history.
   */
  private async connect(input: string): Promise<void> {
    const args = input.trim().split(/\s+/).slice(1);
    if (args.length > 1)
      throw new Error(
        "Usage: /connect [address]. The token is asked for next, hidden: do not type it here.",
      );
    this.prompting = true;
    let outcome: Awaited<ReturnType<typeof connectController>> | undefined;
    try {
      outcome = await connectController(
        this.host,
        {
          address: (current) =>
            showPrompt(this.tui, this.colours, {
              title: "Poundlock controller address",
              step: "1 of 2",
              detail: [
                `For example ${EXAMPLE_CONTROLLER_URL}. A remote HTTPS controller also works.`,
                ...(current ? ["Enter keeps the saved address."] : []),
              ],
              initial: current,
            }),
          token: (saved) =>
            showPrompt(this.tui, this.colours, {
              title: "Application token",
              step: "2 of 2",
              detail: [
                "One application token from Poundlock Access. Stored only on this computer, never shown, and never included in prompts or worker jobs.",
                ...(saved ? ["Enter keeps the saved token."] : []),
              ],
              secret: true,
            }),
        },
        args[0],
        // The test can take seconds; without a word, the screen looked hung.
        (label) => {
          this.working = label;
          this.paint();
        },
      );
      this.host.setNotice({
        kind: outcome.kind === "failed" ? "error" : "info",
        text: outcome.text,
      });
      await this.host.emitState();
    } finally {
      this.prompting = false;
      this.working = undefined;
    }
    if (outcome?.kind === "connected") await this.chooseMissingModels();
  }

  /**
   * The app's setup, step 2: once connected, choose the Manager and the Worker
   * that are not set yet, in the same pickers `/role <role>` opens.
   */
  private async chooseMissingModels(): Promise<void> {
    const missing = async (role: "manager" | "interactive") =>
      !(await this.host.getState()).connection.roles?.[role]?.profileId;
    for (const role of ["manager", "interactive"] as const) {
      if (!(await missing(role))) continue;
      await this.setRole(`/role ${role}`);
      // Escape leaves the rest to /role, as closing the app's setup does.
      if (await missing(role)) return;
    }
  }

  /** `/new` and `/new-run`, confirmed in a picker as the app's Project menu confirms them. */
  private async projectAction(id: ConfirmedProjectAction): Promise<boolean> {
    return confirmProjectAction(id, {
      host: this.host,
      tui: this.tui,
      colours: this.colours,
      state: await this.host.getState(),
    });
  }

  /**
   * `/archive` and `/remove`. This screen is bound to its folder, so once the
   * project is gone it closes and says what happened; opening the folder again
   * starts a new project.
   */
  private async leaveProject(id: "archive" | "remove"): Promise<void> {
    if (!(await this.projectAction(id))) return;
    const said = (await this.host.getState()).notice?.text;
    await this.stop();
    if (said) process.stdout.write(`${said}\n`);
    this.exit(0);
  }

  /**
   * `/grant-file` and `/revoke-file`: Project settings' read exceptions. A
   * relative path is in the project's folder; the host grants the real file a
   * link points at, so taking one back matches on that too.
   */
  private async readGrant(input: string, change: "grant" | "revoke"): Promise<void> {
    const id = this.requireProject();
    const typed = input.trim().replace(/^\S+\s*/, "");
    if (!typed) throw new Error(`Usage: /${change}-file <path>`);
    const path = resolve(this.folder() ?? process.cwd(), typed);
    if (change === "grant") {
      await this.host.grantReadFile(id, path);
      this.host.setNotice({ kind: "info", text: `The manager may now read ${path}.` });
    } else {
      const project = (await this.host.getState()).projects.find((item) => item.id === id);
      const real = await realpath(path).catch(() => path);
      const grants = project?.policy.readGrants ?? [];
      if (!project || !grants.includes(real)) throw new Error(`${path} is not a read exception.`);
      await this.host.updateProjectPolicy(id, {
        ...project.policy,
        readGrants: grants.filter((grant) => grant !== real),
      });
      this.host.setNotice({ kind: "info", text: `The manager may no longer read ${real}.` });
    }
    await this.host.emitState();
  }

  /** `/checks`: list, add, remove or clear the project's verification commands. */
  private async checks(input: string): Promise<void> {
    const id = this.requireProject();
    const project = (await this.host.getState()).projects.find((item) => item.id === id);
    if (!project) throw new Error("Open a project first.");
    const result = checksCommand(project.policy, input.trim().slice("/checks".length));
    if (result.policy) await this.host.updateProjectPolicy(id, result.policy);
    this.host.setNotice({ kind: "info", text: result.notice });
    await this.host.emitState();
  }

  /** `/project-model [manager|worker] [profile|default]`, bound against what Poundlock serves now. */
  private async projectModel(input: string): Promise<void> {
    const id = this.requireProject();
    const args = input.trim().slice("/project-model".length);
    // Naming a profile binds against the catalog Poundlock serves now, as /role does.
    const [, profile] = args.trim().split(/\s+/);
    const naming = Boolean(profile) && profile !== "default";
    if (naming) await this.host.refreshServerInfo();
    const state = await this.host.getState();
    const project = state.projects.find((item) => item.id === id);
    if (!project) throw new Error("Open a project first.");
    if (naming && !state.probe?.ok)
      throw new Error(`Poundlock is not reachable: ${state.probe?.error ?? "unknown"}`);
    const catalog = catalogFromProbe({ interactiveModels: state.probe?.interactiveModels ?? [] });
    const result = projectModelCommand(project.policy, args, catalog);
    if (result.policy) await this.host.updateProjectPolicy(id, result.policy);
    this.host.setNotice({ kind: "info", text: result.notice });
    await this.host.emitState();
  }

  /** `/fix-rounds [n|default]`: how often a failing task goes back to its worker. */
  private async fixRounds(input: string): Promise<void> {
    const { wanted, id, state, project } = await this.projectCommand(input);
    const result = fixRoundsCommand(project.policy, wanted, state.permissions.fixRoundsPerTask);
    if (result.policy) await this.host.updateProjectPolicy(id, result.policy);
    this.host.setNotice({ kind: "info", text: result.notice });
    await this.host.emitState();
  }

  /** `/permissions …`: Settings → Permissions, for every project on this computer. */
  private async permissions(input: string): Promise<void> {
    const { state, project } = await this.projectCommand(input);
    const result = permissionsCommand(
      {
        settings: state.permissions,
        projects: state.projects,
        catalog: catalogFromProbe({ interactiveModels: state.probe?.interactiveModels ?? [] }),
        project,
      },
      input.trim().replace(/^\S+/, ""),
    );
    if (result.settings) await this.host.savePermissions(result.settings);
    this.host.setNotice({ kind: "info", text: result.notice });
    await this.host.emitState();
  }

  /** `/ladder …`: Settings → Model ladder. Saving pauses active work, as in the app. */
  private async ladder(input: string): Promise<void> {
    const state = await this.host.getState();
    const catalog = catalogFromProbe({ interactiveModels: state.probe?.interactiveModels ?? [] });
    const result = ladderCommand(state.connection, catalog, input.trim().replace(/^\S+/, ""));
    const saved = result.ladder ? await this.host.saveEscalation(result.ladder) : undefined;
    const paused = saved?.notice?.text;
    this.host.setNotice({
      kind: "info",
      text: paused ? `${result.notice}\n${paused}` : result.notice,
    });
    await this.host.emitState();
  }

  /**
   * `/local-manager …`: the manager on a model server on this computer. The
   * token is asked for hidden, as `/connect` asks for its own, and the server
   * is tested before anything is saved.
   */
  private async localManager(input: string): Promise<void> {
    const saved = (await this.host.getState()).connection.localManager;
    const parsed = parseLocalManager(input.trim().replace(/^\S+/, ""), saved);
    if (parsed.action === "show") {
      this.host.setNotice({ kind: "info", text: localManagerLines(saved) });
      await this.host.emitState();
      return;
    }
    if (parsed.action === "off") {
      await this.host.saveLocalManager(localManagerOff(saved));
      await this.host.emitState();
      return;
    }
    this.prompting = true;
    let token: string | undefined;
    try {
      token = await showPrompt(this.tui, this.colours, {
        title: "Local server token",
        detail: [
          "The token your model server on this computer expects, if any. Stored only on this computer, never shown.",
          saved?.tokenConfigured ? "Enter keeps the saved token." : "Enter for none.",
        ],
        secret: true,
      });
    } finally {
      this.prompting = false;
    }
    if (token === undefined) return;
    const { request } = parsed;
    this.working = `Testing ${request.url}`;
    this.paint();
    try {
      const probe = await this.host.testLocalManager({
        url: request.url,
        model: request.model,
        token,
      });
      await this.host.saveLocalManager(localManagerSettings(request, probe, saved, token));
    } finally {
      this.working = undefined;
    }
    await this.host.emitState();
  }

  /** `/accounts …`: Settings → Integrations, with the token asked for hidden. */
  private async accounts(input: string): Promise<void> {
    const { integrations } = await this.host.getState();
    const request = parseAccounts(input.trim().replace(/^\S+/, ""), integrations);
    if (request.action === "show") {
      this.host.setNotice({ kind: "info", text: accountLines(integrations) });
    } else if (request.action === "remove") {
      await this.host.removeForge(request.kind);
    } else {
      this.prompting = true;
      let token: string | undefined;
      try {
        token = await showPrompt(this.tui, this.colours, {
          title: `${request.title} token`,
          detail: [
            TOKEN_HINT[request.kind],
            "Stored only on this computer, never shown, never sent to Poundlock.",
            ...(integrations[request.kind]?.configured ? ["Enter keeps the saved token."] : []),
          ],
          secret: true,
        });
      } finally {
        this.prompting = false;
      }
      if (token === undefined) return;
      const account = { host: request.host, username: request.username, token };
      if (request.kind === "github") await this.host.saveGithub(account);
      else await this.host.saveGitea(account);
    }
    await this.host.emitState();
  }

  /** `/appearance …`: Settings → Appearance. The bell is this client's own; the rest is the host's. */
  private async appearance(input: string): Promise<void> {
    const change = parseAppearance(input.trim().replace(/^\S+/, ""), await this.host.getState());
    const saved = await this.preferences.read();
    if (change.action === "theme") {
      await this.host.saveAppearance({ theme: change.theme });
      this.colours.retheme(change.theme);
      ensureHighlightTheme(this.colours);
      // Drawn lines are cached with the old colours.
      this.tui.invalidate();
    }
    if (change.action === "chips")
      await this.host.saveUiPreferences({ composerInfolets: change.composerInfolets });
    if (change.action === "notify") await this.preferences.write({ ...saved, bell: change.bell });
    const bell = change.action === "notify" ? change.bell : saved.bell;
    this.host.setNotice({ kind: "info", text: appearanceLines(await this.host.getState(), bell) });
    await this.host.emitState();
  }

  /** The task `/task` opened, as it stands now. */
  private renderTask(width: number): string[] {
    const snapshot = this.state?.snapshot;
    const task = snapshot?.tasks.find((item) => item.id === this.taskShown?.taskId);
    if (!snapshot || !task || !this.state)
      return ["That task is no longer on the board. /chat to return."];
    const attempt =
      task.attempts.find((item) => item.number === this.taskShown?.attempt) ?? task.attempts.at(-1);
    const rounds = fixRoundsPerTask(
      snapshot.project.policy.fixRoundsPerTask,
      this.state.permissions.fixRoundsPerTask,
    );
    return renderTaskEvidence({ task, attempt }, rounds, width, this.colours);
  }

  /** `/runtime [node <number|folder|none>]`: Project settings → Node runtime. */
  private async runtime(input: string): Promise<void> {
    const { id, project } = await this.projectCommand(input);
    const args = input.trim().replace(/^\S+/, "");
    const candidates = await this.host.runtimeCandidates();
    if (!args.trim()) {
      this.host.setNotice({ kind: "info", text: runtimeLines(project, candidates) });
    } else {
      await this.host.setProjectRuntime(id, "node", runtimeChoice(args, candidates));
    }
    await this.host.emitState();
  }

  /** `/repo-account [github|gitea|none]`: Project settings → repository access. */
  private async repoAccount(input: string): Promise<void> {
    const { wanted, id, project } = await this.projectCommand(input);
    if (!wanted) this.host.setNotice({ kind: "info", text: repoAccountLine(project) });
    else await this.host.attachForge(id, repoAccountChoice(wanted));
    await this.host.emitState();
  }

  /** `/websearch [on|off]`: whether this project's manager and Planner may search the web. */
  private async webSearch(input: string): Promise<void> {
    const { wanted, id, state, project } = await this.projectCommand(input);
    if (wanted === "engine") {
      // Settings → Connection → Web search: one SearXNG for every project, or none.
      const [, , url, ...extra] = input.trim().split(/\s+/);
      if (!url || extra.length) throw new Error(WEB_SEARCH_USAGE);
      await this.host.saveWebSearch(url === "none" ? null : url);
      await this.host.emitState();
      return;
    }
    const result = webSearchCommand(project.policy, wanted, state.connection.webSearch?.url);
    if (result.policy) await this.host.updateProjectPolicy(id, result.policy);
    this.host.setNotice({ kind: "info", text: result.notice });
    await this.host.emitState();
  }

  /** `/transcript [normal|verbose]`: how much of the work the conversation shows. */
  private async transcriptDensity(input: string): Promise<void> {
    const [, wanted] = input.trim().split(/\s+/);
    if (wanted !== undefined && !isTranscriptDensity(wanted))
      throw new Error("Usage: /transcript [normal|verbose]");
    if (wanted && wanted !== this.density) {
      await this.preferences.write({
        ...(await this.preferences.read()),
        transcriptDensity: wanted,
      });
      this.density = wanted;
    }
    this.host.setNotice({ kind: "info", text: `Transcript: ${TRANSCRIPT_DENSITY[this.density]}` });
    await this.host.emitState();
  }

  /**
   * Let this project use another folder. Write access is spelled out rather
   * than assumed, because a granted folder is somebody else's repository.
   */
  private async grant(input: string): Promise<void> {
    const [, path, mode = "read"] = input.split(/\s+/);
    if (!path) throw new Error("Usage: /grant <path> [read|write]");
    if (mode !== "read" && mode !== "write") throw new Error("Grant a folder as read or write.");
    await this.host.grantRoot(this.requireProject(), path, mode);
  }

  /**
   * This conversation's manager reasoning. With no argument, lists what the
   * manager's profile offers and what the next turn will use; `default` goes
   * back to the Manager default.
   */
  private async reasoning(input: string): Promise<void> {
    const { wanted, id, state, project } = await this.projectCommand(input);
    const view = conversationReasoningView({
      project,
      roles: state.connection.roles,
      models: state.probe?.interactiveModels ?? [],
      localManager: Boolean(state.connection.localManager?.enabled && !project.managerEscalation),
    });
    if (!wanted) {
      // An error (an unverified profile, say) explains itself better as text
      // than as a list of choices that may not even apply; only offer the
      // picker once there is a clean set of choices to show in it.
      if (view.error || !view.offered.length) {
        this.host.setNotice({
          kind: view.error ? "error" : "info",
          text: [
            `Manager reasoning for this conversation: ${
              project.reasoningOverride
                ? reasoningLabel(project.reasoningOverride)
                : "Manager default"
            }${view.effective ? ` (next turn: ${reasoningLabel(view.effective)})` : ""}.`,
            `Offered by ${view.profileName ?? "the manager"}: ${view.offered.map((choice) => choice).join(", ")}.`,
            view.error ?? "Change it with /reasoning <setting>, or /reasoning default.",
          ].join("\n"),
        });
        await this.host.emitState();
        return;
      }
      const items: SelectItem[] = [
        ...view.offered.map((choice) => ({ value: choice, label: reasoningLabel(choice) })),
        { value: "default", label: "Manager default" },
      ];
      const picked = await showPicker(this.tui, this.colours, items, {
        title: "Manager reasoning for this conversation",
      });
      if (picked) await this.reasoning(`/reasoning ${picked.value}`);
      return;
    }
    const choice = wanted === "default" ? undefined : wanted;
    if (choice !== undefined && !isReasoningChoice(choice))
      throw new Error(`Unknown setting ${wanted}. One of: ${view.offered.join(", ")}, default.`);
    await this.host.setConversationReasoning(id, choice);
    this.host.setNotice({
      kind: "info",
      text: `Manager reasoning for this conversation: ${
        choice ? reasoningLabel(choice) : "Manager default"
      }. Takes effect from the next turn.`,
    });
    await this.host.emitState();
  }

  /**
   * How this project's worker actions are approved: the terminal's version of
   * the desktop app's permissions chip. With no argument, shows the modes;
   * `default` goes back to the machine-wide setting.
   */
  private async trust(input: string): Promise<void> {
    const { wanted, id, state, project } = await this.projectCommand(input);
    const describe = (override: ToolTrustMode | undefined) =>
      `${toolTrustLabel(effectiveToolTrust(override, state.permissions))} (${
        override ? "this project" : "machine default"
      })`;
    if (!wanted) {
      const items: SelectItem[] = [
        ...TOOL_TRUST_MODES.map((mode) => ({
          value: mode.id,
          label: mode.label,
          description: mode.hint,
        })),
        { value: "default", label: "Machine default", description: describe(undefined) },
      ];
      const picked = await showPicker(this.tui, this.colours, items, {
        title: "Worker permissions for this project",
      });
      if (picked) await this.trust(`/trust ${picked.value}`);
      return;
    }
    const modes = TOOL_TRUST_MODES.map((mode) => mode.id);
    const choice = modes.find((mode) => mode === wanted);
    if (wanted !== "default" && !choice)
      throw new Error(`Unknown mode ${wanted}. One of: ${modes.join(", ")}, default.`);
    await this.host.updateProjectPolicy(id, { ...project.policy, toolTrust: choice });
    this.host.setNotice({ kind: "info", text: `Worker permissions: ${describe(choice)}.` });
    await this.host.emitState();
  }

  /**
   * The project's Internet and Local network switches (ADR 015). With no
   * argument, shows the four settings with the current one named.
   */
  private async network(input: string): Promise<void> {
    const { wanted, id, project } = await this.projectCommand(input);
    if (!wanted) {
      const current = describeReach(projectReach(project.policy));
      const items: SelectItem[] = Object.entries(NETWORK_CHOICES).map(([value, reach]) => ({
        value,
        label: describeReach(reach),
        description: describeReach(reach) === current ? "current" : "",
      }));
      const picked = await showPicker(this.tui, this.colours, items, {
        title: "Network for this project's commands",
      });
      if (picked) await this.network(`/network ${picked.value}`);
      return;
    }
    const reach = NETWORK_CHOICES[wanted as keyof typeof NETWORK_CHOICES];
    if (!reach)
      throw new Error(
        `Unknown setting ${wanted}. One of: ${Object.keys(NETWORK_CHOICES).join(", ")}.`,
      );
    // Web search is kept, and goes off with the internet (ADR 017).
    const webSearch = reach.internet && (project.policy.network?.webSearch ?? false);
    await this.host.updateProjectPolicy(id, {
      ...project.policy,
      network: { ...reach, webSearch },
    });
    this.host.setNotice({ kind: "info", text: `Network: ${describeReach(reach)}.` });
    await this.host.emitState();
  }

  /** A project command's argument, with the open project and the state it was read from. */
  private async projectCommand(input: string) {
    const [, wanted] = input.trim().split(/\s+/);
    const id = this.requireProject();
    const state = await this.host.getState();
    const project = state.projects.find((item) => item.id === id);
    if (!project) throw new Error("Open a project first.");
    return { wanted, id, state, project };
  }

  private requireProject(): string {
    const id = this.state?.selectedProjectId;
    if (!id) throw new Error("Open a project first.");
    return id;
  }

  /**
   * Re-confirm where each role's model runs, after Poundlock changes the route
   * behind a profile. This is a consent decision, so it names the destinations
   * being approved rather than approving them silently — the same thing saving
   * the model map does in the desktop app.
   */
  private async approveModels(): Promise<void> {
    // Approval is against the route Poundlock advertises right now, so the
    // catalog has to be fresh — approving against a stale one would record a
    // revision the controller no longer serves.
    await this.host.refreshServerInfo();
    const roles = (await this.host.getState()).connection.roles ?? {};
    const destinations = Object.entries(roles)
      .filter((entry): entry is [string, RoleBinding] => Boolean(entry[1]))
      .map(([role, binding]) => ({
        role,
        text: `${role}: ${binding.profileName ?? binding.profileId} → ${binding.approvedDataDestination ?? "unknown"}`,
      }));
    if (!destinations.length)
      throw new Error("No models are mapped yet. Set them in the desktop app.");
    // A route change is a consent decision, so it is named — every
    // destination it would send context to — rather than approved silently
    // on the strength of one command.
    const items: SelectItem[] = [
      {
        value: "approve",
        label: "Approve this route",
        description: destinations.map((entry) => entry.text).join("; "),
      },
      { value: "cancel", label: "Cancel" },
    ];
    const picked = await showPicker(this.tui, this.colours, items, {
      title: "Approve the route Poundlock is serving now",
    });
    if (!picked || picked.value === "cancel") return;
    await this.host.saveModels(roles);
    this.host.setNotice({
      kind: "info",
      text: `Approved the current route for ${destinations.map((entry) => entry.text).join(", ")}.`,
    });
    await this.host.emitState();
  }

  /**
   * The catalog Poundlock is serving right now, and what each role is bound
   * to. Without this a terminal-only user could not see the profile names
   * `/role` takes, let alone choose between them.
   */
  private async listModels(input: string): Promise<void> {
    await this.host.refreshServerInfo();
    const state = await this.host.getState();
    if (!state.probe?.ok)
      throw new Error(`Poundlock is not reachable: ${state.probe?.error ?? "unknown"}`);
    const catalog = catalogFromProbe({ interactiveModels: state.probe.interactiveModels ?? [] });
    if (!catalog.length) throw new Error("Poundlock is serving no model profiles.");
    const wanted = input.trim().slice("/models".length).trim();
    if (wanted) {
      // `<profile> destination <own|external|reported>`: Models and routing's override.
      const override = /^(.+?)\s+destination(?:\s+(\S+))?$/.exec(wanted);
      const profile = matchProfile(catalog, override?.[1] ?? wanted);
      const id = profile.profileId ?? profile.id;
      if (override) {
        if (!override[2]) throw new Error(DESTINATION_USAGE);
        const saved = await this.host.saveProfile(id, {
          ...state.connection.profiles?.[id],
          approvedDestination: destinationOverride(override[2]),
        });
        state.connection = saved.connection;
      }
      this.host.setNotice({
        kind: "info",
        text: modelDetailLines(profile, state.connection.profiles?.[id]?.approvedDestination).join(
          "\n",
        ),
      });
      await this.host.emitState();
      return;
    }
    const lines = [
      "Model profiles Poundlock is serving:",
      ...modelListRows(catalog, state.connection.roles ?? {}),
      "",
      `Roles: ${EXECUTION_ROLES.join(", ")}. Bind one with /role <role> <profile>.`,
      "Changing a role ends the current manager session and needs /approve-models.",
      "/models <profile> says more about one.",
    ];
    this.host.setNotice({ kind: "info", text: lines.join("\n") });
    await this.host.emitState();
  }

  /**
   * Bind one role to one profile — the terminal equivalent of the desktop
   * app's model picker. Until this existed a terminal-only user had to
   * install the desktop app to choose which model manages their work.
   */
  private async setRole(input: string): Promise<void> {
    const [, role, ...rest] = input.trim().split(/\s+/);
    const wanted = rest.join(" ");
    if (!role) throw new Error(`Name a role: /role <${EXECUTION_ROLES.join("|")}> [profile]`);
    if (!(EXECUTION_ROLES as readonly string[]).includes(role))
      throw new Error(`Unknown role ${role}. One of: ${EXECUTION_ROLES.join(", ")}`);

    // Bind against the catalog Poundlock is serving now, not a remembered
    // one: a name that no longer resolves is worse than a refusal.
    await this.host.refreshServerInfo();
    const state = await this.host.getState();
    if (!state.probe?.ok)
      throw new Error(`Poundlock is not reachable: ${state.probe?.error ?? "unknown"}`);
    const catalog = catalogFromProbe({ interactiveModels: state.probe.interactiveModels ?? [] });

    if (!wanted) {
      // No profile named: offer every profile Poundlock serves, destination
      // and all — an unavailable one is still shown (silence would look like
      // the terminal missed it), but picking it below refuses exactly as
      // typing its name would.
      if (!catalog.length) throw new Error("Poundlock is serving no model profiles.");
      const items: SelectItem[] = catalog.map((profile) => {
        const reason = roleUnavailableReason(profile, role as ExecutionRole);
        const destination = profile.dataDestination ?? "unknown";
        return {
          value: profile.profileId ?? profile.id,
          label: profile.name,
          description: reason ? `${destination} — unavailable: ${reason}` : destination,
        };
      });
      // Highlighted: the current binding, else the app's setup suggestion.
      const suggested = { ...guessRoleMap(state.probe), ...state.connection.roles }[
        role as ExecutionRole
      ];
      const picked = await showPicker(this.tui, this.colours, items, {
        title: `Model for the ${role} role`,
        initial: suggested?.profileId,
      });
      if (picked) await this.setRole(`/role ${role} ${picked.value}`);
      return;
    }

    const chosen = matchProfile(catalog, wanted);
    // The same check the desktop picker applies. Without it the terminal
    // saved a binding the first turn would then refuse — a blocked
    // destination, an autocomplete model as manager — with the error arriving
    // minutes later instead of here.
    const unavailable = roleUnavailableReason(chosen, role as ExecutionRole);
    if (unavailable) throw new Error(`${chosen.name} cannot serve ${role}: ${unavailable}.`);

    // The same binding the desktop app's picker saves.
    const roles: RoleMap = {
      ...(state.connection.roles ?? {}),
      [role]: bindingForProfile(chosen),
    };
    await this.host.saveModels(roles);
    this.host.setNotice({
      kind: "info",
      text: `${role} now runs on ${chosen.name} (${chosen.dataDestination ?? "unknown"}). The manager session was reset.`,
    });
    await this.host.emitState();
  }

  /**
   * Run one host action. A refusal is shown rather than thrown: the host
   * rejects for ordinary reasons — another client holds the folder, the
   * composer is blocked — and none of them should end the session.
   */
  private async run(work: () => Promise<unknown>, label?: string): Promise<void> {
    if (label) {
      this.working = label;
      this.paint();
    }
    try {
      await work();
    } catch (error) {
      this.host.setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      await this.host.emitState();
    } finally {
      if (label) {
        this.working = undefined;
        this.paint();
      }
    }
  }
}
