/**
 * The plan, approval and question cards, pinned above the status lines so they
 * stay in view while the conversation scrolls, and which of them has the keys.
 */

import { type Component, Container, type TUI } from "@earendil-works/pi-tui";
import { approvalView } from "@shared/approval-view";
import type { ToolApproval } from "@shared/permissions";
import type { AppStateView } from "@shared/types";
import { LineView } from "./app-views.js";
import { Card, type CardSpec } from "./card.js";
import { keyHints, rule, wrap } from "./chrome.js";
import type { Colours } from "./colour.js";
import { approvalCardParts, needsInputTitle, planCardBody } from "./render.js";

/** Rows the chrome always takes: title bar (2), status (2), composer box (3) and its keys (1). */
const CHROME_ROWS = 8;

/**
 * The most rows a card may take: what is left after the chrome and `keep`
 * lines of conversation to leave in view. A card never grows past this, so
 * the composer is never pushed off the bottom.
 */
function cardRoom(keep: number): number {
  const rows = process.stdout.rows || 30;
  return Math.max(8, Math.min(24, rows - CHROME_ROWS - keep));
}

const choiceKeys =
  (colours: Colours, escape: string, extra: { key: string; label: string }[] = []) =>
  (inner: number) =>
    keyHints(
      colours,
      [
        { key: "↑↓", label: "choose" },
        { key: "Enter", label: "confirm" },
        ...extra,
        { key: "Esc", label: escape },
      ],
      inner,
    );

export interface CardContext {
  state: AppStateView;
  colours: Colours;
  /** The decision this client must answer before anything else can happen. */
  pending: ToolApproval | undefined;
  decideApproval(id: string, decision: string): void;
  replyInput(choice: string): void;
  toComposer(): void;
  autopilot: CardSpec | undefined;
}

/** The cards the current state calls for, newest decision nearest the composer. */
export function cardSpecs(context: CardContext): CardSpec[] {
  const { state, colours, pending } = context;
  const snapshot = state.snapshot;
  if (!snapshot) return [];
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
        maxHeight: cardRoom(2),
        choices: {
          items: [
            { value: "once", label: view.once, description: "[a]" },
            { value: "always", label: view.remember, description: "[s]" },
            { value: "deny", label: view.deny, description: "[d]" },
          ],
          onSelect: (item) => context.decideApproval(pending.id, item.value),
          onCancel: () => context.toComposer(),
        },
        footer: choiceKeys(colours, "type instead", [{ key: "a/s/d", label: "answer now" }]),
      },
    ];
  }
  const specs: CardSpec[] = [];
  const room = cardRoom(5);
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
              label: choice.description ? `${choice.label} — ${choice.description}` : choice.label,
            })),
            onSelect: (item) => context.replyInput(item.value),
            onCancel: () => context.toComposer(),
          }
        : undefined,
      footer: decision
        ? choiceKeys(colours, ownWords ? "reply in your own words" : "message box")
        : "Reply in the message box below.",
    });
  }
  if (context.autopilot) specs.push(context.autopilot);
  return specs;
}

/** The cards on screen, kept by key across paints, and whether one of them has the keys. */
export class CardDeck {
  readonly slot = new Container();
  /** Separates the scrolling transcript from the pinned bottom, when no card does. */
  readonly divider: LineView;
  /**
   * A card is rebuilt only when its decision changes, so the answer
   * highlighted in it survives a state update.
   */
  private cards = new Map<string, Card>();
  /** Where keys go: the composer, or the card with answers to choose. */
  focus: "composer" | "card" = "composer";
  /** The card focus last moved for; focus moves on its own only for a new one. */
  private announced: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly composer: Component,
    private readonly colours: Colours,
    /** Whether anything is half-typed in the composer. */
    private readonly drafting: () => boolean,
  ) {
    this.divider = new LineView((width) =>
      this.cards.size ? [] : [rule(width, undefined, colours)],
    );
  }

  get size(): number {
    return this.cards.size;
  }

  /** Keep a card object per decision; rebuild the slot's order to match. */
  sync(specs: CardSpec[]): void {
    const next = new Map<string, Card>();
    for (const spec of specs) {
      const existing = this.cards.get(spec.key);
      if (existing) existing.update(spec);
      next.set(spec.key, existing ?? new Card(spec, this.colours));
    }
    this.cards = next;
    this.slot.clear();
    for (const card of next.values()) this.slot.addChild(card);
  }

  /** The card that can take the keyboard: the last with answers to choose. */
  choosable(): Card | undefined {
    return [...this.cards.values()].filter((card) => card.choosable).at(-1);
  }

  /**
   * Move the keyboard only when a new decision appears, and then only if
   * nothing is half-typed: a card that shows up mid-sentence must not take
   * the next Enter. Tab moves to it from there.
   */
  applyFocus(): void {
    const card = this.choosable();
    if (!card) {
      this.focus = "composer";
      this.announced = undefined;
    } else if (card.key !== this.announced) {
      this.announced = card.key;
      if (!this.drafting()) this.focus = "card";
    }
    this.tui.setFocus(this.focus === "card" && card ? card : this.composer);
  }

  focusCard(): void {
    this.focus = "card";
    this.applyFocus();
    this.tui.requestRender();
  }

  toComposer(): void {
    this.focus = "composer";
    this.tui.setFocus(this.composer);
    this.tui.requestRender();
  }
}
