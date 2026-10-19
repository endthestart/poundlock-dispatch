/**
 * A decision card: the plan, an approval or a question, boxed and pinned
 * above the composer so it stays in view while the conversation scrolls.
 *
 * The border's colour says what kind of decision it is (the design
 * language's rule: colour means state), and the title says it in words. A
 * card that offers answers carries a pi-tui `SelectList` inside the box; the
 * card is focusable only to hand keys to that list.
 *
 * A card never grows past what it is given. Its body is cut, with a line that
 * says where the rest is, so the composer under it is always on screen: a
 * long plan must not push the box you type in off the bottom.
 */
import {
  type Component,
  type Focusable,
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { frame } from "./chrome.js";
import type { Colours } from "./colour.js";
import { pickerTheme } from "./picker.js";

export interface CardSpec {
  /** Identity: a new key is a new decision, which is when focus may move to it. */
  key: string;
  title: string;
  /** review for an approval that blocks you, accent for a plan, accent2 for a question. */
  role: "review" | "accent" | "accent2";
  /** The card's text, wrapped to the width inside the box. */
  body: (inner: number) => string[];
  /**
   * Lines that are never cut, set after the body: the exact command an
   * approval asks about. The body gives way to them, not the other way round.
   */
  pinned?: (inner: number) => string[];
  /** Above this, the body is cut and `overflow` says where the rest is. */
  maxBodyLines?: number;
  /**
   * The most lines the whole card may take, borders, answers and footer
   * included. The body gives up whatever the rest needs, never less than a few
   * lines of itself.
   */
  maxHeight?: number;
  overflow?: string;
  /** Answers to choose from, with arrows and Enter. */
  choices?: {
    items: SelectItem[];
    onSelect: (item: SelectItem) => void;
    onCancel?: () => void;
  };
  /**
   * One quiet line under everything, such as the keys that answer. Given the
   * width inside the box when it is a function, so it can drop what will not fit.
   */
  footer?: string | ((inner: number) => string);
}

/** The fewest lines of body a card keeps however little room it is given. */
const MIN_BODY_LINES = 3;

export class Card implements Component, Focusable {
  focused = false;
  private list?: SelectList;
  /** Mutated before each render: the answers' column is as wide as the widest answer. */
  private readonly layout: SelectListLayoutOptions = {};

  constructor(
    private spec: CardSpec,
    private readonly colours: Colours,
  ) {
    this.buildList();
  }

  get key(): string {
    return this.spec.key;
  }

  /** Whether the card has answers to choose, and so can take the keyboard. */
  get choosable(): boolean {
    return Boolean(this.list);
  }

  /**
   * New text for the same decision. The list, and the answer highlighted in
   * it, survive: a state update while you are choosing must not move the
   * highlight back to the top.
   */
  update(spec: CardSpec): void {
    const hadChoices = JSON.stringify(this.spec.choices?.items);
    this.spec = spec;
    if (JSON.stringify(spec.choices?.items) !== hadChoices) this.buildList();
    else if (this.list && spec.choices) {
      this.list.onSelect = spec.choices.onSelect;
      this.list.onCancel = spec.choices.onCancel;
    }
  }

  private buildList(): void {
    const choices = this.spec.choices;
    if (!choices?.items.length) {
      this.list = undefined;
      return;
    }
    this.list = new SelectList(
      choices.items,
      Math.min(8, choices.items.length),
      pickerTheme(this.colours),
      this.layout,
    );
    this.list.onSelect = choices.onSelect;
    this.list.onCancel = choices.onCancel;
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  invalidate(): void {
    this.list?.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);

    // The answers first, because the body gets whatever they leave.
    let choices: string[] = [];
    if (this.list) {
      const widest = Math.max(
        ...(this.spec.choices?.items ?? []).map((item) => visibleWidth(item.label ?? item.value)),
      );
      // Wide enough that no answer is cut, unless the box itself is too narrow.
      const column = Math.max(8, Math.min(widest + 2, inner - 10));
      this.layout.minPrimaryColumnWidth = column;
      this.layout.maxPrimaryColumnWidth = column;
      choices = this.list.render(inner);
    }
    const footer =
      typeof this.spec.footer === "function" ? this.spec.footer(inner) : this.spec.footer;
    const pinned = this.spec.pinned?.(inner) ?? [];
    const full = this.spec.body(inner);

    // What is under the body, with or without the blank lines that set each
    // part apart. A card with room keeps them all; one that would have to cut
    // its body to fit gives them up one at a time, the footer's first and the
    // request's last, since a line of the request is worth more than a line of
    // air.
    const arrange = (gaps: { request: boolean; answers: boolean; footer: boolean }) => {
      // The pinned request arrives with its own blank line above it.
      const exact = gaps.request || pinned[0] !== "" ? pinned : pinned.slice(1);
      const fixed = [
        ...exact,
        ...(choices.length ? [...(gaps.answers ? [""] : []), ...choices] : []),
        ...(footer ? [...(gaps.footer ? [""] : []), this.colours.paint("faint", footer)] : []),
      ];
      const room =
        this.spec.maxHeight === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(MIN_BODY_LINES, this.spec.maxHeight - 2 - fixed.length);
      return { fixed, limit: Math.min(this.spec.maxBodyLines ?? Number.POSITIVE_INFINITY, room) };
    };
    const options = [
      { request: true, answers: true, footer: true },
      { request: true, answers: true, footer: false },
      { request: true, answers: false, footer: false },
      { request: false, answers: false, footer: false },
    ].map(arrange);
    const layout = options.find((option) => full.length <= option.limit) ?? options.at(-1)!;

    let body = full;
    if (body.length > layout.limit) {
      const more = body.length - (layout.limit - 1);
      body = [
        ...body.slice(0, layout.limit - 1),
        this.colours.paint(
          "faint",
          `… ${more} more line${more === 1 ? "" : "s"}${this.spec.overflow ? ` · ${this.spec.overflow}` : ""}`,
        ),
      ];
    }
    return frame(this.colours, this.spec.role, this.spec.title, [...body, ...layout.fixed], width);
  }
}
