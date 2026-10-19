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

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { newestRun, statusLines } from "@core/auto/runs";
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
import {
  effectiveToolTrust,
  TOOL_TRUST_MODES,
  type ToolTrustMode,
  toolTrustLabel,
} from "@shared/permissions";
import { projectStatusView } from "@shared/project-status";
import { conversationReasoningView, isReasoningChoice, reasoningLabel } from "@shared/reasoning";
import type { ExecutionRole, RoleBinding, RoleMap } from "@shared/roles";
import {
  bindingForProfile,
  catalogFromProbe,
  EXECUTION_ROLES,
  roleUnavailableReason,
} from "@shared/roles";
import { compactOffered } from "@shared/status-infolets";
import { type AppStateView, EXAMPLE_CONTROLLER_URL } from "@shared/types";
import { type AutoCliDeps, runAuto, splitCommandLine } from "./auto.js";
import { BoxedEditor } from "./boxed-editor.js";
import { Card, type CardSpec } from "./card.js";
import { fitSentence, GUTTER, gutter, type KeyHint, keyHints, rule } from "./chrome.js";
import { type ColourRole, type Colours, resolveColours } from "./colour.js";
import { COMMAND_DEFS, NETWORK_CHOICES, toSlashCommands } from "./commands.js";
import { connectController } from "./connect.js";
import { displaySafe } from "./jobs.js";
import { ensureHighlightTheme, markdownTheme } from "./markdown-theme.js";
import { showPicker } from "./picker.js";
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
import { TranscriptView } from "./transcript.js";

type ScreenId = "conversation" | "board" | "setup";

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
  /** A run whose card `/auto hide` put away; it comes back for the next run. */
  private autoHidden: string | undefined;
  private autoTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly host: DispatchHost,
    private readonly tui: TUI = defaultTui(),
    private readonly exit: (code: number) => void = (code) => process.exit(code),
    colours: Colours = resolveColours(),
    /** Local auto mode's commands (ADR 014); without them `/auto` is unavailable. */
    private readonly autoDeps?: Omit<AutoCliDeps, "io">,
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
    else {
      if (snapshot) {
        const pending = this.pendingDecision();
        // A pending decision is the only thing left to act on, so the
        // transcript shows just enough of it for context, and its own
        // reply-in-progress (there cannot be one — a turn does not stream
        // while an approval is open) is never shown either.
        this.transcript.sync(
          pending ? snapshot.messages.slice(-4) : snapshot.messages,
          pending ? undefined : state.managerDraft,
        );
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
    if (this.screen === "setup")
      return [
        { key: "/chat", label: "back to chat" },
        { key: "/connect", label: "connection" },
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
      ...(status ? actionHints(status.actions) : []),
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
        title: "Auto run · verified, not reviewed",
        role: "accent2",
        // Activity and reasons carry the model's words: nothing in them may drive the terminal.
        body: (inner) => lines.flatMap((line) => wrap(displaySafe(line), inner)),
        maxBodyLines: 8,
        footer:
          "/auto stop · /auto stop --now · /auto export · /auto hide · runs on after you quit",
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
    let lines: string[] | undefined;
    if (runDir && runDir !== this.autoHidden) {
      const current = await statusLines(runDir).catch(() => undefined);
      const ended = current?.some((line) => line.startsWith("Ended:"));
      const status = await stat(join(runDir, "status.json")).catch(() => undefined);
      const recent = !status || Date.now() - status.mtimeMs < 30 * 60_000;
      lines = !ended || recent ? current : undefined;
    }
    if (this.closing) return;
    if (runDir === this.autoRun && JSON.stringify(lines) === JSON.stringify(this.autoLines)) return;
    this.autoRun = runDir;
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
    if (!this.autoDeps) throw new Error("Local auto mode is not available in this client.");
    if (!folder) throw new Error("Open a folder first: an auto run works on one repository.");
    const [command = "status", ...rest] = splitCommandLine(input).slice(1);
    if (command === "hide") {
      this.autoHidden = this.autoRun;
      this.autoLines = undefined;
      this.paint();
      return;
    }
    if (command === "watch" || command === "attach") {
      this.autoHidden = undefined;
      await this.refreshAuto();
      return;
    }
    if (command === "run") throw new Error("The runner starts from /auto start or /auto resume.");
    const argv = [command, ...rest];
    const named = rest.length > 0 && !rest[0].startsWith("-");
    const hasDir = rest.some((word) => word === "--dir" || word.startsWith("--dir="));
    if (!hasDir && (command === "start" || command === "list" || !named))
      argv.push("--dir", folder);
    if (command === "start" && !rest.includes("--no-wait")) argv.push("--no-wait");
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
      [
        "/approve-models",
        async () => this.run(() => this.approveModels(), "Asking Poundlock for the current route…"),
      ],
      [
        "/models",
        async () => this.run(() => this.listModels(), "Asking Poundlock for its models…"),
      ],
      ["/role", async (input) => this.run(() => this.setRole(input), "Checking with Poundlock…")],
      ["/reasoning", async (input) => this.run(() => this.reasoning(input))],
      ["/trust", async (input) => this.run(() => this.trust(input))],
      ["/network", async (input) => this.run(() => this.network(input))],
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
    try {
      const outcome = await connectController(
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
    const [, wanted] = input.trim().split(/\s+/);
    const id = this.requireProject();
    const state = await this.host.getState();
    const project = state.projects.find((item) => item.id === id);
    if (!project) throw new Error("Open a project first.");
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
    const [, wanted] = input.trim().split(/\s+/);
    const id = this.requireProject();
    const state = await this.host.getState();
    const project = state.projects.find((item) => item.id === id);
    if (!project) throw new Error("Open a project first.");
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
    const [, wanted] = input.trim().split(/\s+/);
    const id = this.requireProject();
    const state = await this.host.getState();
    const project = state.projects.find((item) => item.id === id);
    if (!project) throw new Error("Open a project first.");
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
  private async listModels(): Promise<void> {
    await this.host.refreshServerInfo();
    const state = await this.host.getState();
    if (!state.probe?.ok)
      throw new Error(`Poundlock is not reachable: ${state.probe?.error ?? "unknown"}`);
    const catalog = catalogFromProbe({ interactiveModels: state.probe.interactiveModels ?? [] });
    if (!catalog.length) throw new Error("Poundlock is serving no model profiles.");
    const bound = new Map(
      Object.entries(state.connection.roles ?? {})
        .filter(([, binding]) => binding)
        .map(([role, binding]) => [`${binding!.profileId}`, role]),
    );
    const lines = [
      "Model profiles Poundlock is serving:",
      ...catalog.map((profile) => {
        const role = bound.get(profile.profileId ?? profile.id);
        const where = profile.dataDestination ?? "unknown";
        return `  ${profile.name.padEnd(24)}${where.padEnd(18)}${role ? `← ${role}` : ""}`;
      }),
      "",
      `Roles: ${EXECUTION_ROLES.join(", ")}. Bind one with /role <role> <profile>.`,
      "Changing a role ends the current manager session and needs /approve-models.",
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
      const picked = await showPicker(this.tui, this.colours, items, {
        title: `Model for the ${role} role`,
      });
      if (picked) await this.setRole(`/role ${role} ${picked.value}`);
      return;
    }

    const matches = catalog.filter(
      (profile) =>
        profile.name === wanted ||
        profile.profileId === wanted ||
        profile.id === wanted ||
        profile.aliases.includes(wanted),
    );
    if (!matches.length)
      throw new Error(`No profile named ${wanted}. Run /models to see what is being served.`);
    const [chosen] = matches;
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
