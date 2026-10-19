/**
 * A `SelectList` shown as a centred, titled box: the shape every picker in
 * this file (`/role`, `/reasoning`, `/trust`, `/approve-models`) is built
 * from. There is no bespoke picker widget here — pi-tui's `SelectList` already
 * filters, scrolls and reports a selection or a cancellation; this just gives
 * it somewhere to appear, a title saying what is being chosen, the keys that
 * choose, and a theme that matches the rest of the screen.
 */
import {
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  type SelectListTheme,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { frame, keyHints, wrap } from "./chrome.js";
import type { Colours } from "./colour.js";

export function pickerTheme(colours: Colours): SelectListTheme {
  return {
    selectedPrefix: (text) => colours.paint("accent", `> ${text}`),
    selectedText: (text) => colours.style("bold", colours.paint("accent", text)),
    description: (text) => colours.paint("faint", text),
    scrollInfo: (text) => colours.paint("faint", text),
    noMatch: (text) => colours.paint("faint", text),
  };
}

export interface PickerOptions {
  /** What is being chosen, in the box's top border. */
  title?: string;
}

/**
 * The list, framed: a title on top and the keys underneath. Each item shows
 * only its label in the list; what the highlighted one means is set out in
 * full under the list. A description beside its label was cut wherever the
 * box ran out, mid-word, and the desktop app's picker never cuts one.
 */
class PickerBox implements Component, Focusable {
  focused = false;

  /**
   * `layout` is the object the list was built with. The box widens its label
   * column through it before each render, so a label is never cut while there
   * is room for it.
   */
  constructor(
    private readonly colours: Colours,
    private readonly title: string,
    private readonly list: SelectList,
    private readonly items: SelectItem[],
    private readonly layout: SelectListLayoutOptions,
  ) {}

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const widest = Math.max(...this.items.map((item) => visibleWidth(item.label ?? item.value)));
    this.layout.minPrimaryColumnWidth = Math.max(8, Math.min(widest + 2, inner - 2));
    this.layout.maxPrimaryColumnWidth = this.layout.minPrimaryColumnWidth;

    // The tallest description sets the space kept for it, so the box does not
    // change height as the highlight moves.
    const described = this.items.filter((item) => item.description);
    const reserved = Math.max(
      0,
      ...described.map((item) => wrap(item.description ?? "", inner).length),
    );
    const current = this.items.find((item) => item.value === this.list.getSelectedItem()?.value);
    const detail = wrap(current?.description ?? "", inner).map((line) =>
      this.colours.paint("muted", line),
    );
    while (reserved && detail.length < reserved) detail.push("");

    const keys = keyHints(
      this.colours,
      [
        { key: "↑↓", label: "choose" },
        { key: "Enter", label: "select" },
        { key: "Esc", label: "cancel" },
      ],
      inner,
    );
    return frame(
      this.colours,
      "accent",
      this.title,
      [...this.list.render(inner), ...(reserved ? ["", ...detail] : []), "", keys],
      width,
    );
  }
}

/**
 * Show `items` in an overlay and resolve with the one chosen, or `undefined`
 * on Escape/Ctrl+C. The overlay hides itself either way — callers never call
 * `hide()` themselves, so there is only one place that can leave it stuck open.
 */
export function showPicker(
  tui: TUI,
  colours: Colours,
  items: SelectItem[],
  options: PickerOptions = {},
): Promise<SelectItem | undefined> {
  return new Promise((resolve) => {
    const layout: SelectListLayoutOptions = {};
    // The list gets the labels alone; the box says what the highlighted one means.
    const labels = items.map(({ description: _description, ...rest }) => rest);
    const list = new SelectList(labels, Math.min(10, items.length), pickerTheme(colours), layout);
    const box = new PickerBox(colours, options.title ?? "Choose one", list, items, layout);
    let handle: OverlayHandle | undefined;
    let settled = false;
    const finish = (value: SelectItem | undefined) => {
      if (settled) return;
      settled = true;
      handle?.hide();
      resolve(value);
    };
    list.onSelect = (item) => finish(item);
    list.onCancel = () => finish(undefined);
    handle = tui.showOverlay(box, {
      anchor: "center",
      width: "80%",
      minWidth: 40,
      maxHeight: "70%",
    });
  });
}
