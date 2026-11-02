/**
 * The pinned bottom's words: the two status lines above the composer, with the
 * spinner while anything runs, and the line of keys under it, which a short
 * message can take over for a few seconds.
 */

import type { DispatchHost } from "@core/host/dispatch-host";
import type { TUI } from "@earendil-works/pi-tui";
import { autopilotOwnsStatus } from "@shared/autopilot-card";
import { projectStatusView } from "@shared/project-status";
import { compactOffered } from "@shared/status-infolets";
import type { AppStateView } from "@shared/types";
import type { CardDeck } from "./app-cards.js";
import { LineView, type ScreenId } from "./app-views.js";
import { GUTTER, gutter, type KeyHint, keyHints } from "./chrome.js";
import type { ColourRole, Colours } from "./colour.js";
import { actionHints, renderStatusLines } from "./render.js";

/** How long a one-line message (an unknown command, a cleared draft) stays where the keys are. */
const FLASH_MS = 4000;

/** Braille frames, the same set pi's own loader uses. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;

export interface StatusContext {
  tui: TUI;
  colours: Colours;
  state(): AppStateView | undefined;
  screen(): ScreenId;
  deck: CardDeck;
}

export class StatusBar {
  /** Pinned above the composer, so what the run is doing never scrolls away. */
  readonly lines: LineView;
  /** What a slow command is doing, shown as activity until it finishes. */
  working: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  /** A short message in place of the key hints, until `flashUntil`. */
  private flash: { text: string; role: ColourRole } | undefined;
  private flashUntil = 0;

  constructor(private readonly context: StatusContext) {
    this.lines = new LineView((width) => {
      const now = context.state();
      if (!now) return ["", ""];
      // A slow command's own label stands in for the activity the host has not reported.
      const state = this.working
        ? { ...now, busy: true, activity: now.activity ?? this.working }
        : now;
      const active = Boolean(state.busy || state.activity);
      const [one, two] = renderStatusLines(
        state,
        Math.max(1, width - GUTTER * 2),
        context.colours,
        active ? SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] : undefined,
        context.screen() !== "board",
      );
      return gutter([one, two]).map((line) => line || " ");
    });
  }

  /** The line under the composer: a passing message if there is one, else the keys. */
  footer(inner: number): string {
    const { colours } = this.context;
    if (this.flash && Date.now() < this.flashUntil)
      return colours.paint(this.flash.role, this.flash.text);
    return keyHints(colours, keysFor(this.context), inner);
  }

  /** Say something short in the key line, for a few seconds. */
  say(text: string, role: ColourRole, ms = FLASH_MS): void {
    const { tui } = this.context;
    this.flash = { text, role };
    this.flashUntil = Date.now() + ms;
    tui.requestRender();
    setTimeout(() => tui.requestRender(), ms + 50).unref();
  }

  /** Animate the spinner while anything is running, and only then. */
  sync(): void {
    const state = this.context.state();
    if (!state || !(state.busy || state.activity || this.working)) {
      this.stop();
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame += 1;
      this.context.tui.requestRender();
    }, SPINNER_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The keys that do something right now, with the ones this state calls for first. */
function keysFor({ state: read, screen: current, deck }: StatusContext): KeyHint[] {
  if (deck.focus === "card")
    return [
      { key: "Esc", label: "type a message" },
      { key: "Tab", label: "board" },
      { key: "Ctrl+C", label: "exit" },
    ];
  const scroll: KeyHint = { key: "PgUp/PgDn", label: "scroll" };
  const search: KeyHint = { key: "Ctrl+R", label: "search" };
  const exit: KeyHint = { key: "Ctrl+C", label: "exit" };
  const screen = current();
  if (screen === "board")
    return [
      { key: "Tab", label: "back to chat" },
      { key: "/", label: "commands" },
      scroll,
      search,
      exit,
    ];
  if (screen !== "conversation")
    return [
      { key: "/chat", label: "back to chat" },
      ...(screen === "setup" ? [{ key: "/connect", label: "connection" }] : []),
      { key: "/", label: "commands" },
      scroll,
      exit,
    ];
  const state = read();
  const snapshot = state?.snapshot;
  const status = snapshot
    ? projectStatusView(snapshot, { approvals: state?.approvals })
    : undefined;
  const card = deck.choosable();
  return [
    ...(card ? [{ key: "Tab", label: "answer the card" }] : []),
    ...(status && !autopilotOwnsStatus(state?.autopilot, status.cause)
      ? actionHints(status.actions)
      : []),
    ...(state && compactOffered(state) ? [{ key: "/compact", label: "free up context" }] : []),
    { key: "Enter", label: "send" },
    { key: "/", label: "commands" },
    ...(card ? [] : [{ key: "Tab", label: "board" }]),
    search,
    scroll,
    exit,
  ];
}

/**
 * Run one host action, naming it beside the spinner while it runs. A refusal
 * is shown rather than thrown: the host rejects for ordinary reasons — another
 * client holds the folder, the composer is blocked — and none of them should
 * end the session.
 */
export async function runAction(
  context: { host: DispatchHost; status: StatusBar; paint(): void },
  work: () => Promise<unknown>,
  label?: string,
): Promise<void> {
  const { host, status, paint } = context;
  if (label) {
    status.working = label;
    paint();
  }
  try {
    await work();
  } catch (error) {
    host.setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    await host.emitState();
  } finally {
    if (label) {
      status.working = undefined;
      paint();
    }
  }
}
