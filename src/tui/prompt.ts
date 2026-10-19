/**
 * A one-line question in a centred overlay, with an optional hidden answer:
 * what `/connect` asks the controller address and the application token with.
 *
 * pi-tui's `Input` does the typing (paste, Unicode, backspace); this file adds
 * the two things it cannot: a masked display, and a box to sit in. A secret is
 * never drawn, never handed to anything but the caller's `resolve`, and never
 * put anywhere a later screen could read it back — not the composer's history,
 * not the transcript, not a log line.
 */
import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  getKeybindings,
  Input,
  type Keybinding,
  type OverlayHandle,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { frame, keyHints } from "./chrome.js";
import type { Colours } from "./colour.js";

const MASK = "•";
const PROMPT = "> ";

/**
 * Keys that would move the cursor or edit away from the end of the line. The
 * mask shows only how many characters there are, not where the cursor sits, so
 * these are ignored and the cursor stays at the end: typing, pasting and
 * backspace behave, and what is on screen is what is being edited.
 */
const MOVES: Keybinding[] = [
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineEnd",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.undo",
];

/** A single-line input that shows a bullet for every character. */
export class SecretInput implements Component, Focusable {
  focused = false;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  private readonly input = new Input({ prompt: PROMPT });

  constructor() {
    this.input.onSubmit = (value) => this.onSubmit?.(value);
    this.input.onEscape = () => this.onCancel?.();
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (MOVES.some((key) => keys.matches(data, key))) return;
    this.input.handleInput(data);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const room = Math.max(1, width - PROMPT.length - 1);
    const count = [...this.input.getValue()].length;
    // A token longer than the box shows its last characters' worth of bullets.
    const dots = MASK.repeat(Math.min(count, room));
    return [`${PROMPT}${dots}${this.focused ? CURSOR_MARKER : ""}`];
  }
}

/** The question, what it is for, and the field, in a titled box. Keys go to the field. */
class PromptBox implements Component, Focusable {
  constructor(
    private readonly colours: Colours,
    private readonly title: string,
    private readonly detail: string[],
    private readonly field: Component & Focusable,
  ) {}

  get focused(): boolean {
    return this.field.focused;
  }

  set focused(value: boolean) {
    this.field.focused = value;
  }

  handleInput(data: string): void {
    this.field.handleInput?.(data);
  }

  invalidate(): void {
    this.field.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - 4);
    return frame(
      this.colours,
      "accent",
      this.title,
      [
        ...this.detail.flatMap((line) =>
          wrapTextWithAnsi(this.colours.paint("muted", line), inner),
        ),
        "",
        ...this.field.render(inner),
        "",
        keyHints(
          this.colours,
          [
            { key: "Enter", label: "confirm" },
            { key: "Esc", label: "cancel" },
          ],
          inner,
        ),
      ],
      width,
    );
  }
}

export interface PromptOptions {
  title: string;
  /** Which of a few questions this is, such as "1 of 2", shown beside the title. */
  step?: string;
  /** Plain sentences under the title: what is being asked and where it goes. */
  detail?: string[];
  /** Show bullets instead of what is typed. */
  secret?: boolean;
  /** What a plain (not secret) field starts with. */
  initial?: string;
}

/** The field for a plain prompt: pi-tui's own `Input`, with the focus flag its box needs. */
function plainField(initial: string | undefined) {
  const input = new Input({ prompt: PROMPT });
  if (initial) input.setValue(initial);
  return input;
}

/**
 * Ask one question in an overlay. Resolves with what was entered (possibly
 * empty), or `undefined` on Escape or Ctrl+C. The overlay hides itself either
 * way, and the field is dropped, so nothing typed outlives the answer.
 */
export function showPrompt(
  tui: TUI,
  colours: Colours,
  options: PromptOptions,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const field = options.secret ? new SecretInput() : plainField(options.initial);
    let handle: OverlayHandle | undefined;
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      handle?.hide();
      resolve(value);
    };
    field.onSubmit = (value) => finish(value);
    if (field instanceof SecretInput) field.onCancel = () => finish(undefined);
    else field.onEscape = () => finish(undefined);
    const title = options.step ? `${options.title} · ${options.step}` : options.title;
    handle = tui.showOverlay(new PromptBox(colours, title, options.detail ?? [], field), {
      anchor: "center",
      width: "70%",
      minWidth: 40,
      maxHeight: "60%",
    });
  });
}
