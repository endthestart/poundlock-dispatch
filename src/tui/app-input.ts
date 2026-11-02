/** What a keystroke or a submitted line means: a shortcut, a slash command, a message or an answer. */

import type { DispatchHost } from "@core/host/dispatch-host";
import { type Editor, matchesKey } from "@earendil-works/pi-tui";
import type { ToolApproval } from "@shared/permissions";
import type { AppStateView } from "@shared/types";
import type { CardDeck } from "./app-cards.js";
import type { Screens } from "./app-screens.js";
import type { StatusBar } from "./app-status.js";

/** How long a first Ctrl+C stays armed. Long enough to mean it, short enough not to accumulate. */
const QUIT_CONFIRM_MS = 3000;

export interface InputContext {
  host: DispatchHost;
  editor: Editor;
  status: StatusBar;
  deck: CardDeck;
  screens: Screens;
  state(): AppStateView | undefined;
  /** A question overlay (`/connect`) is open: every key belongs to it, none is a shortcut. */
  prompting(): boolean;
  /** The decision this client must answer before anything else can happen. */
  pending(): ToolApproval | undefined;
  target(): { projectId: string } | undefined;
  paint(): void;
  run(work: () => Promise<unknown>): Promise<void>;
  command(input: string): Promise<void>;
  quit(): Promise<void>;
}

export class Input {
  /** Set by a first Ctrl+C; a second one within this window exits. */
  private quitArmedAt = 0;

  constructor(private readonly context: InputContext) {}

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
    const { editor, status, deck, screens } = this.context;
    if (this.context.prompting()) return undefined;
    if (matchesKey(data, "ctrl+c"))
      return async () => {
        // Never exit on one keystroke. Ctrl+C first abandons what you were
        // typing; only a second press, while nothing is left to abandon,
        // leaves — and only within a short window, so a stray Ctrl+C minutes
        // ago cannot combine with one now to end the session.
        if (editor.getText().trim().length) {
          editor.setText("");
          this.quitArmedAt = 0;
          status.say("Cleared. Ctrl+C again to exit.", "review", QUIT_CONFIRM_MS);
          return;
        }
        const now = Date.now();
        if (now - this.quitArmedAt <= QUIT_CONFIRM_MS) {
          await this.context.quit();
          return;
        }
        this.quitArmedAt = now;
        status.say("Ctrl+C again to exit.", "review", QUIT_CONFIRM_MS);
      };
    if (matchesKey(data, "tab")) {
      // From the composer, Tab goes to a card waiting for an answer; with
      // none, it switches between the conversation and the board.
      if (deck.focus === "composer" && screens.current === "conversation" && deck.choosable())
        return async () => deck.focusCard();
      return async () => {
        screens.current = screens.current === "board" ? "conversation" : "board";
        this.context.paint();
      };
    }
    // The letters answer only while the approval card has the keyboard, so
    // a card that appears mid-sentence never turns a typed letter into a
    // decision.
    const pending = this.context.pending();
    if (!pending || deck.focus !== "card") return undefined;
    const decision = { a: "once", s: "always", d: "deny" }[data];
    return decision ? () => this.context.host.decideApproval(pending.id, decision) : undefined;
  }

  async submit(text: string): Promise<void> {
    const { editor, screens, host } = this.context;
    const trimmed = text.trim();
    editor.setText("");
    if (!trimmed) return;
    // `/connect <address> <more>` may be a token pasted where it does not
    // belong; it stays out of the up-arrow history.
    if (!/^\/connect\s+\S+\s+\S/.test(trimmed)) editor.addToHistory(trimmed);
    if (trimmed.startsWith("/")) {
      await this.context.command(trimmed);
      return;
    }
    // The reply lands in the transcript, so a message sent from the setup or
    // board screen brings the conversation back rather than arriving unseen.
    if (screens.current !== "conversation") {
      screens.current = "conversation";
      this.context.paint();
    }
    const needsInput = this.context.state()?.snapshot?.project.needsInput;
    if (!needsInput) {
      await this.context.run(() => host.sendMessage(trimmed, this.context.target()));
      return;
    }
    // A bare number picks that choice; anything else is a free-text answer.
    const choices = needsInput.choices ?? [];
    const index = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
    const choice = index >= 1 && index <= choices.length ? choices[index - 1].id : trimmed;
    await this.context.run(() => host.replyInput(choice, this.context.target()));
  }
}
