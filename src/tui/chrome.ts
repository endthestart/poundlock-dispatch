/**
 * The small pieces every screen is laid out from: fit a line to a width, put
 * something at each end of it, wrap a paragraph, draw a rule, and name the
 * keys.
 *
 * All of it is width in terminal columns (`visibleWidth`), not string length:
 * a status line with a wide glyph or an escape code in it is as wide as it
 * looks, and a box built from these never comes out a column off. Nothing
 * here knows about the workflow; `render.ts` decides what to say and this
 * decides how it is set.
 */
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { displaySafe } from "@shared/display-safe";
import { type ColourRole, type Colours, PLAIN } from "./colour.js";

/** The left margin the whole screen shares, so text lines up with what sits inside a box. */
export const GUTTER = 2;

const ESC_CHAR = String.fromCharCode(27);

export const indentBy = (columns: number): string => " ".repeat(Math.max(0, columns));

/**
 * Cut to `width` columns, ending in an ellipsis when something was lost. Plain
 * text stays plain: pi-tui closes the cut with a reset, which is right after
 * colour and noise after nothing.
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const cut = truncateToWidth(text, width, "…");
  return text.includes(ESC_CHAR) ? cut : stripTerminalSequences(cut);
}

/** Pad with spaces to `width` columns; never truncates. */
export function padTo(text: string, width: number): string {
  return text + indentBy(width - visibleWidth(text));
}

/**
 * `left` at the left edge and `right` at the right, on one line of `width`
 * columns. When both do not fit the right side goes: it is the more
 * dispensable of the two everywhere this is used (a hint, an aside), and a
 * left side cut short says less than a missing right side does.
 */
export function spread(left: string, right: string, width: number, gap = 2): string {
  const rightWidth = visibleWidth(right);
  const room = width - visibleWidth(left) - gap;
  if (!right || rightWidth > room) return clip(left, width);
  return `${left}${indentBy(width - visibleWidth(left) - rightWidth)}${right}`;
}

/** Break a word that is wider than a line into lines that are not. */
function breakWord(word: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const character of word) {
    if (piece && visibleWidth(piece + character) > width) {
      pieces.push(piece);
      piece = "";
    }
    piece += character;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * Wrap plain text to `width` columns. Paragraphs (split on newlines) stay
 * apart, every line starts with `indent`, and a single word wider than the
 * line — a path, a URL, a hash — is broken rather than left to overflow, so a
 * box drawn around the result cannot be pushed out of shape by one long token.
 */
export function wrap(text: string, width: number, indent = ""): string[] {
  const room = Math.max(1, width);
  const lines: string[] = [];
  // Everything wrapped here is text from a model, a project or a server: no
  // escape sequence in it reaches the terminal (M9).
  for (const paragraph of displaySafe(text).split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let current = indent;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current.trim() ? `${current} ${word}` : `${indent}${word}`;
      if (visibleWidth(candidate) <= room) {
        current = candidate;
        continue;
      }
      if (current.trim()) lines.push(current);
      const start = `${indent}${word}`;
      if (visibleWidth(start) <= room) {
        current = start;
        continue;
      }
      const pieces = breakWord(word, Math.max(1, room - visibleWidth(indent)));
      for (const piece of pieces.slice(0, -1)) lines.push(`${indent}${piece}`);
      current = `${indent}${pieces.at(-1) ?? ""}`;
    }
    if (current.trim()) lines.push(current);
  }
  return lines;
}

/**
 * Wrap text to `width` columns without touching its spacing: every run of
 * spaces, every line break, survives, and only the point a line is cut moves.
 * For text that has to be shown exactly (a command someone is being asked to
 * allow, a table) where `wrap` would rejoin its words with single spaces.
 * Every line starts with `indent`.
 */
export function wrapExact(text: string, width: number, indent = ""): string[] {
  const room = Math.max(1, width - visibleWidth(indent));
  return displaySafe(text)
    .split("\n")
    .flatMap((line) => (line.trim() ? wrapTextWithAnsi(line, room) : [""]))
    .map((line) => (line ? `${indent}${line}` : line));
}

/**
 * A horizontal rule the width of the screen, with an optional label set into
 * it: `── label ──────`. The label is the only part painted in `role`; the
 * dashes stay quiet.
 */
export function rule(
  width: number,
  label?: string,
  colours: Colours = PLAIN,
  role: ColourRole = "accent",
): string {
  const dashes = (count: number) => colours.paint("line", "─".repeat(Math.max(0, count)));
  if (!label) return dashes(width);
  const text = ` ${label} `;
  const shown = clip(text, Math.max(0, width - 4));
  return `${dashes(2)}${colours.paint(role, shown)}${dashes(width - 2 - visibleWidth(shown))}`;
}

/** A state's dot and its words, in that state's colour: `● Running`. */
export function chip(colours: Colours, role: ColourRole, label: string): string {
  return colours.paint(role, `● ${label}`);
}

/** One key and what it does. */
export interface KeyHint {
  key: string;
  label: string;
}

/**
 * Keys and what they do, one line: `Enter send · / commands · Tab board`.
 * The key is the part to notice, so it takes the accent; the label is plain
 * enough to read. In the order given, most important first, because the ones
 * that do not fit are dropped from the end rather than squeezed: a hint cut
 * in half teaches the wrong key.
 */
export function keyHints(colours: Colours, hints: KeyHint[], width: number): string {
  const separator = " · ";
  const kept = hints.slice();
  const plain = () => kept.map((hint) => `${hint.key} ${hint.label}`).join(separator);
  while (kept.length > 1 && visibleWidth(plain()) > width) kept.pop();
  const line = kept
    .map((hint) => `${colours.paint("accent", hint.key)} ${colours.paint("muted", hint.label)}`)
    .join(colours.paint("line", separator));
  return clip(line, width);
}

/** One segment of a line that may not fit: what it says, and how soon it goes. */
export interface Part {
  text: string;
  /** Lower stays longer. The part with the highest rank is the first to go. */
  rank: number;
  /** The same text with colour on it. Its width is `text`'s; the line is measured on `text`. */
  styled?: string;
}

/**
 * Choose the parts that fit on one line of `width` columns. When the line is
 * too long the least important part is dropped — not the last one, which is
 * where the number that mattered used to be — until it fits. Order on the
 * line is the order given; `rank` only decides who is dropped.
 */
export function fitParts(parts: Part[], width: number, separator: string): Part[] {
  const joined = (kept: Part[]) => kept.map((part) => part.text).join(separator);
  const kept = parts.slice();
  while (kept.length > 1 && visibleWidth(joined(kept)) > width) {
    let drop = 0;
    for (const [index, part] of kept.entries()) if (part.rank >= kept[drop].rank) drop = index;
    kept.splice(drop, 1);
  }
  return kept;
}

/** Paint and join the parts `fitParts` kept, clipped to the line. */
export function joinParts(
  colours: Colours,
  kept: Part[],
  width: number,
  separator: string,
): string {
  const line = kept.map((part) => part.styled ?? part.text).join(colours.paint("line", separator));
  return clip(line, width);
}

/**
 * A label and its value, the value wrapped to hang under itself:
 *
 *     Scope   Working directory /Users/… · Plan
 *             revision 1, one task
 *
 * `labelWidth` is the widest label in the group, so the values line up. The
 * value is painted in `role` when given, for a state that should be seen at a
 * glance (a check that failed, a token that is missing).
 */
export function labelled(
  colours: Colours,
  label: string,
  value: string,
  width: number,
  labelWidth: number,
  role?: ColourRole,
): string[] {
  const body = wrap(value, Math.max(1, width - labelWidth - 2));
  const paint = (line: string) => (role ? colours.paint(role, line) : line);
  return (body.length ? body : [""]).map((line, index) =>
    index === 0
      ? `${colours.paint("faint", padTo(label, labelWidth))}  ${paint(line)}`
      : `${indentBy(labelWidth + 2)}${paint(line)}`,
  );
}

/**
 * Zero-width prompt markers (OSC 133) the transcript puts at the start of a
 * line so "jump to my last message" can find it. Built from code points to
 * keep the escape characters visible in source.
 */
const BEL = String.fromCharCode(7);
const LEADING_MARKERS = new RegExp(`^(?:${ESC_CHAR}\\][^${BEL}]*${BEL})+`);

/**
 * A left margin on every line: what puts body text on the screen's shared
 * gutter. Blank lines stay blank, and a marker that has to begin its line
 * still does — the margin goes after it.
 */
export function gutter(lines: string[], columns = GUTTER): string[] {
  const margin = indentBy(columns);
  return lines.map((line) => {
    if (!line) return line;
    const marker = LEADING_MARKERS.exec(line)?.[0] ?? "";
    return `${marker}${margin}${line.slice(marker.length)}`;
  });
}

const CORNERS = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯" } as const;

/**
 * A titled box exactly `width` columns wide around `content`, painted in
 * `role`. Every line is fitted to the inside, so one long token cannot push a
 * side out and have the terminal wrap the rest of the frame.
 */
export function frame(
  colours: Colours,
  role: ColourRole,
  title: string,
  content: string[],
  width: number,
): string[] {
  const paint = (text: string) => colours.paint(role, text);
  const inner = Math.max(1, width - 4);
  const label = clip(title, Math.max(1, width - 6));
  const dashes = Math.max(0, width - 5 - visibleWidth(label));
  const out = [
    `${paint(`${CORNERS.topLeft}─ `)}${colours.style("bold", paint(label))}${paint(` ${"─".repeat(dashes)}${CORNERS.topRight}`)}`,
  ];
  const side = paint("│");
  for (const line of content) {
    const fitted = clip(line, inner);
    out.push(`${side} ${padTo(fitted, inner)} ${side}`);
  }
  out.push(
    paint(`${CORNERS.bottomLeft}${"─".repeat(Math.max(0, width - 2))}${CORNERS.bottomRight}`),
  );
  return out;
}

/**
 * A sentence or two cut back to what fits: the whole text if it does, else its
 * first sentence if that does, else the text for the caller to clip. Better a
 * short complete thought than a long one ending in `actio…`.
 */
export function fitSentence(text: string, room: number): string {
  if (visibleWidth(text) <= room) return text;
  const first = /^.*?[.!?](?=\s|$)/.exec(text)?.[0];
  return first && visibleWidth(first) <= room ? first : text;
}
