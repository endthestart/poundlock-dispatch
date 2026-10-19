/**
 * The composer, drawn as a box.
 *
 * pi-tui's `Editor` draws a horizontal rule above and below itself and
 * nothing at the sides, so on screen it reads as two loose lines rather than
 * a field you type into. This wraps it: the rules become the box's top and
 * bottom, and every line between them gets a side.
 *
 * It is a wrapper rather than a fork because the editor's own top and bottom
 * rules carry information — when the text scrolls, they become `─── ↑ 3 more`
 * indicators — and that belongs on the box's edge, exactly where the editor
 * puts it.
 *
 * Two things sit on the frame the editor knows nothing about. What the
 * composer will do (or why it will not send) is set into the top border, where
 * a form field keeps its label; and one line of keys sits under the box. While
 * the slash-command menu is open it takes that line's place, below the box
 * rather than inside it, since the menu is not part of what is being typed.
 */
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  Editor,
  type EditorTheme,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** Box-drawing characters, in the weight the rest of the screen already uses. */
const CORNER = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯" } as const;
const SIDE = "│";

const ESC = String.fromCharCode(27);
/** The reverse-video cell the editor draws as its cursor. */
const FAKE_CURSOR = new RegExp(`${ESC}\\[7m([^${ESC}]*)${ESC}\\[0m`, "g");

/** What the editor puts on its border rows: only rule characters, or a scroll indicator among them. */
const isRule = (line: string) => /^─/.test(stripTerminalSequences(line));

export class BoxedEditor implements Component, Focusable {
  readonly editor: Editor;
  private title: string | ((room: number) => string) = "";
  private footer: string | ((inner: number) => string) = "";

  /**
   * `paintBorder`, when given, colours only the corners, connecting dashes
   * and sides this class draws itself — never `line`, which the wrapped
   * `Editor` already coloured (via `theme.borderColor`) for its own rules and
   * scroll indicators. Wrapping that text again would nest a second escape
   * sequence around one that may already reset, cutting the colour short.
   * It is called on every render, so it may answer differently as focus moves.
   */
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly paintBorder?: (text: string) => string,
  ) {
    this.editor = new Editor(tui, theme);
  }

  /** The TUI sets this on the focused component; the editor is what actually has focus. */
  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    this.editor.handleInput?.(data);
  }

  /** Nothing is cached here; the editor owns its own caching. */
  invalidate(): void {
    this.editor.invalidate?.();
  }

  getText(): string {
    return this.editor.getText();
  }

  setText(text: string): void {
    this.editor.setText(text);
  }

  /**
   * The label set into the top border, already painted. Empty for a plain
   * rule. A function is asked for it at the room the border has, so it can
   * choose a shorter wording than the one that does not fit.
   */
  setTitle(title: string | ((room: number) => string)): void {
    this.title = title;
  }

  /**
   * The line of keys under the box, already painted. Empty for none. A
   * function is asked for the line at the width inside the box, so it can drop
   * whatever will not fit rather than have it cut.
   */
  setFooter(footer: string | ((inner: number) => string)): void {
    this.footer = footer;
  }

  /**
   * Where the editor's bottom rule is among the lines it returned. Anything
   * after it is the slash-command menu. The editor keeps the number of text
   * rows it drew; when that is not to be had, the first rule after the top one
   * is the answer.
   */
  private bottomIndex(lines: string[]): number {
    const drawn = (this.editor as unknown as { renderedVisibleLineCount?: number })
      .renderedVisibleLineCount;
    if (typeof drawn === "number" && lines[drawn + 1] !== undefined && isRule(lines[drawn + 1]))
      return drawn + 1;
    const found = lines.findIndex((line, index) => index > 0 && isRule(line));
    return found === -1 ? lines.length - 1 : found;
  }

  render(width: number): string[] {
    // Two columns for the sides and one of breathing room inside each, so
    // text never sits flush against the border.
    const inner = Math.max(1, width - 4);
    const lines = this.editor.render(inner);
    if (!lines.length) return [];

    const paint = this.paintBorder ?? ((text: string) => text);
    const side = paint(SIDE);
    const bottom = this.bottomIndex(lines);
    const out: string[] = [];
    for (const [index, line] of lines.slice(0, bottom + 1).entries()) {
      if (index === 0) {
        out.push(this.topBorder(line, width, paint));
        continue;
      }
      if (index === bottom) {
        out.push(
          `${paint(CORNER.bottomLeft)}${paint("─")}${line}${paint("─")}${paint(CORNER.bottomRight)}`,
        );
        continue;
      }
      // `visibleWidth` rather than `length`: these lines carry ANSI colour and
      // the zero-width cursor marker the TUI strips to place the hardware
      // cursor. Padding on raw length would put the right side in the wrong
      // column and drag the cursor with it.
      const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
      out.push(`${side} ${this.focused ? line : line.replace(FAKE_CURSOR, "$1")}${pad} ${side}`);
    }
    const menu = lines.slice(bottom + 1);
    if (menu.length) for (const line of menu) out.push(`  ${truncateToWidth(line, inner)}`);
    else {
      const footer = typeof this.footer === "function" ? this.footer(inner) : this.footer;
      if (footer) out.push(`  ${truncateToWidth(footer, inner)}`);
    }
    return out;
  }

  /**
   * The top edge: the editor's own rule, with the label set into it. A rule
   * that is carrying a scroll indicator is left as the editor drew it, since
   * that says something the label does not.
   */
  private topBorder(rule: string, width: number, paint: (text: string) => string): string {
    const carriesIndicator = /[^─]/.test(stripTerminalSequences(rule));
    const room = width - 2;
    const wanted =
      typeof this.title === "function" ? this.title(Math.max(1, room - 4)) : this.title;
    if (!wanted || carriesIndicator || width < 12) {
      return `${paint(CORNER.topLeft)}${paint("─")}${rule}${paint("─")}${paint(CORNER.topRight)}`;
    }
    // Between the corners: `─ label ────`.
    const label = truncateToWidth(wanted, Math.max(1, room - 4), "…");
    const dashes = Math.max(1, room - 3 - visibleWidth(label));
    return `${paint(CORNER.topLeft)}${paint("─")} ${label} ${paint("─".repeat(dashes))}${paint(CORNER.topRight)}`;
  }
}
