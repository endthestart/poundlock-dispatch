/** The pieces the terminal client is built from: views drawn at their width, the prose column, the composer's theme and the real terminal. */

import {
  type Component,
  KeybindingsManager,
  ProcessTerminal,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { GUTTER, gutter } from "./chrome.js";
import { type ColourRole, type Colours, resolveColours } from "./colour.js";
import type { TranscriptView } from "./transcript.js";

export type ScreenId = "conversation" | "board" | "setup" | "history" | "run" | "task";

/** Ctrl+R first: it arrives unchanged in every terminal. See `defaultTui`. */
export const SEARCH_KEYS = ["ctrl+r", "ctrl+shift+f"] as const;

/**
 * The composer's border says whether it is the thing to type into: the accent
 * while it has the keyboard, and the quiet line colour while a card holds it
 * or the composer is refusing to send until a decision is made.
 */
export function editorTheme(colours: Colours, border: () => ColourRole) {
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

/**
 * The widest a paragraph or a code fence gets before it wraps, even on a very
 * wide terminal. The chrome around it — the title bar, the status lines, the
 * composer's box — still spans the full terminal width; only prose is
 * capped, because a paragraph stretched across 200 columns reads worse than
 * one left flush at a comfortable width with room to spare.
 */
const PROSE_CAP = 100;

/** A component whose lines are made when it is drawn, from the width it is drawn at. */
export class LineView implements Component {
  constructor(private readonly build: (width: number) => string[]) {}

  render(width: number): string[] {
    return this.build(width);
  }

  invalidate(): void {}
}

/** The column prose is set in: capped, and inside the screen's left margin. */
export function proseColumn(width: number): number {
  return Math.max(1, Math.min(width, PROSE_CAP) - GUTTER);
}

/** A component that renders `TranscriptView` in the prose column, not full width. */
export class TranscriptComponent implements Component {
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
export function defaultTui(): TuiAltScreen {
  const colours = resolveColours();
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.search": [...SEARCH_KEYS] }),
  );
  return new TuiAltScreen(new ProcessTerminal(), true, undefined, {
    mouse: true,
    copySelection: async (text) => {
      try {
        const { copyToClipboard } = await import("@earendil-works/pi-coding-agent");
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
