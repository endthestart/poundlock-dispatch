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

import type { DispatchHost } from "@core/host/dispatch-host";
import type { Editor, TUI } from "@earendil-works/pi-tui";
import type { TranscriptDensity } from "@shared/live-work-view";
import type { AppStateView } from "@shared/types";
import { AutopilotPanel } from "./app-autopilot.js";
import { CardDeck, cardSpecs } from "./app-cards.js";
import { type CommandSurface, projectTarget } from "./app-command-surface.js";
import { commandTable } from "./app-command-table.js";
import { Composer } from "./app-composer.js";
import { Input } from "./app-input.js";
import { connect } from "./app-model-commands.js";
import { Screens } from "./app-screens.js";
import { localFolder, pendingDecision, retryableTask } from "./app-state.js";
import { runAction, StatusBar } from "./app-status.js";
import { defaultTui, type ScreenId } from "./app-views.js";
import type { AutoCliDeps } from "./auto-context.js";
import { type Colours, resolveColours } from "./colour.js";
import { ensureHighlightTheme, onHighlighterLoaded } from "./markdown-theme.js";
import { memoryPreferences, type TuiPreferenceStore } from "./preferences.js";

export class TuiApp {
  private state: AppStateView | undefined;
  private readonly screens: Screens;
  private readonly deck: CardDeck;
  private readonly status: StatusBar;
  private readonly composer: Composer;
  private readonly input: Input;
  private readonly autopilot: AutopilotPanel;
  /** A question overlay (`/connect`) is open: every key belongs to it, none is a shortcut. */
  private prompting = false;
  private stopState: (() => void) | undefined;
  private stopHighlighter: (() => void) | undefined;
  private closing = false;
  /** Keyed by name (with the leading "/"); built once, since every entry only closes over `this`. */
  private readonly commands: Map<string, (input: string) => Promise<void>>;
  /** What the slash-command handlers in `app-*-commands.ts` may use of this client. */
  private readonly surface: CommandSurface;
  /** How much of the work the transcript shows: `/transcript`, remembered on this computer. */
  private density: TranscriptDensity = "normal";

  constructor(
    private readonly host: DispatchHost,
    private readonly tui: TUI = defaultTui(),
    private readonly exit: (code: number) => void = (code) => process.exit(code),
    /** Resolved once at startup: the saved theme, this terminal's colour depth, NO_COLOR/TTY. */
    private readonly colours: Colours = resolveColours(),
    autoDeps?: Omit<AutoCliDeps, "io">,
    private readonly preferences: TuiPreferenceStore = memoryPreferences(),
  ) {
    const state = () => this.state;
    const paint = () => this.paint();
    this.surface = {
      host,
      tui,
      colours,
      preferences,
      state,
      folder: () => localFolder(this.state),
      setPrompting: (on) => {
        this.prompting = on;
      },
      setWorking: (label) => {
        this.status.working = label;
        paint();
      },
      stagedRoles: {},
    };
    this.autopilot = new AutopilotPanel(
      { ...this.surface, paint, showDetails: () => this.show("run"), closing: () => this.closing },
      autoDeps,
    );
    ensureHighlightTheme(colours);
    this.screens = new Screens({
      state,
      colours,
      runDetails: (width) => this.autopilot.details(width),
    });
    this.composer = new Composer(
      tui,
      colours,
      () => this.deck.focus === "composer",
      (inner) => this.status.footer(inner),
    );
    this.deck = new CardDeck(tui, this.composer.box, colours, () => this.composer.drafting());
    this.status = new StatusBar({
      tui,
      colours,
      state,
      screen: () => this.screens.current,
      deck: this.deck,
    });
    this.input = new Input({
      host,
      editor: this.composer.editor,
      status: this.status,
      deck: this.deck,
      screens: this.screens,
      state,
      prompting: () => this.prompting,
      pending: () => pendingDecision(this.state),
      target: () => this.target(),
      paint,
      run: (work) => this.run(work),
      command: (input) => this.command(input),
      quit: () => this.quit(),
    });
    this.composer.editor.onSubmit = (text) => {
      void this.input.submit(text);
    };
    this.commands = commandTable({
      ...this.surface,
      run: (work, label) => this.run(work, label),
      showScreen: (id) => this.show(id),
      showHistory: (records) => {
        this.screens.showHistory(records);
        paint();
      },
      showTask: (taskId, attempt) => {
        this.screens.showTask(taskId, attempt);
        paint();
      },
      density: () => this.density,
      setDensity: (density) => {
        this.density = density;
      },
      autopilot: (input) => this.autopilot.command(input),
      retryableTask: () => retryableTask(this.state),
      quit: (said) => this.quit(said),
    });
  }

  async start(): Promise<void> {
    // `body`'s children depend on the screen and are assembled in `paint`,
    // which the end of `start` already calls once state has loaded.
    this.screens.attach(this.tui, this.bottom());
    this.tui.setFocus(this.composer.box);
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
    this.composer.prepare(this.state);
    this.paint();
    this.tui.start();
    // Code fences are coloured once the first one has loaded the highlighter.
    this.stopHighlighter = onHighlighterLoaded(() => {
      this.tui.invalidate();
      this.tui.requestRender();
    });
    this.autopilot.start();
    // First run: ask for the controller and token now, rather than leave a
    // screen that cannot do anything until someone finds the desktop app.
    if (!this.state.connection.url || !this.state.connection.tokenConfigured)
      void this.run(() => connect(this.surface, "/connect"));
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
    this.stopHighlighter?.();
    this.status.stop();
    this.autopilot.stop();
    this.tui.stop();
    await this.host.shutdown();
  }

  /**
   * The whole screen as lines at `width`, top to bottom, the way the terminal
   * would show it if it were tall enough. For tests: nothing else asks a
   * component tree what it looks like.
   */
  renderForTest(width: number): string[] {
    return [this.screens.titleBar, this.screens.body, ...this.bottom()].flatMap((component) =>
      component.render(width),
    );
  }

  /** The action a keystroke means right now, or nothing if it is ordinary typing. */
  shortcut(data: string): (() => Promise<unknown>) | undefined {
    return this.input.shortcut(data);
  }

  /** The composer, so a test can put a half-written message in it. */
  editorForTest(): Editor {
    return this.composer.editor;
  }

  /** Which screen is showing, for tests. */
  screenForTest(): ScreenId {
    return this.screens.current;
  }

  /** Submit as if the user pressed Enter. Exposed for tests; the editor calls `submit`. */
  submitForTest(text: string): Promise<void> {
    return this.input.submit(text);
  }

  /** What stays pinned under the scrolling screens: cards, status and the composer. */
  private bottom() {
    return [this.deck.slot, this.deck.divider, this.status.lines, this.composer.box];
  }

  /** Redraw from the current state: which views are showing, which card has the keys, what the composer says. */
  private paint(): void {
    const state = this.state;
    if (!state) return;
    const pending = pendingDecision(state);
    this.screens.paint(state, this.density, Boolean(pending));
    this.deck.sync(
      this.screens.current === "conversation"
        ? cardSpecs({
            state,
            colours: this.colours,
            pending,
            decideApproval: (id, decision) =>
              void this.run(() => this.host.decideApproval(id, decision)),
            replyInput: (choice) =>
              void this.run(() => this.host.replyInput(choice, this.target())),
            toComposer: () => this.deck.toComposer(),
            autopilot: this.autopilot.cardSpec(),
          })
        : [],
    );
    this.status.sync();
    this.deck.applyFocus();
    this.composer.showHint(state);
    this.tui.requestRender();
  }

  private show(screen: ScreenId): void {
    this.screens.current = screen;
    this.paint();
  }

  private target() {
    return projectTarget(this.surface);
  }

  private async quit(said?: string): Promise<void> {
    await this.stop();
    if (said) process.stdout.write(`${said}\n`);
    this.exit(0);
  }

  private async command(input: string): Promise<void> {
    const [name] = input.split(/\s+/);
    const run = this.commands.get(name);
    if (!run) {
      this.status.say(`Unknown command ${name}. Type / to see the commands.`, "fault");
      return;
    }
    await run(input);
  }

  /** Run one host action, showing a refusal rather than throwing it. */
  private run(work: () => Promise<unknown>, label?: string): Promise<void> {
    return runAction(
      { host: this.host, status: this.status, paint: () => this.paint() },
      work,
      label,
    );
  }
}
