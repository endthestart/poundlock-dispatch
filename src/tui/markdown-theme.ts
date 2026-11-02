/**
 * Markdown rendering for the transcript.
 *
 * There is no first-party markdown renderer or syntax highlighter in this
 * codebase, and no reason to write one: pi-tui already ships a `Markdown`
 * component that only needs a theme, and pi-coding-agent already ships a
 * syntax highlighter. This file is the theme, painted with the same
 * Catppuccin roles `colour.ts` uses everywhere else, so a code block or a
 * heading in the manager's reply reads as part of the same screen instead of
 * a second, differently-themed widget dropped into it.
 */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { Colours } from "./colour.js";

type Highlighter = Pick<
  typeof import("@earendil-works/pi-coding-agent"),
  "highlightCode" | "initTheme"
>;

/** pi-coding-agent, once a code fence has brought it in. */
let highlighter: Highlighter | undefined;
let loading: Promise<void> | undefined;
let register: "light" | "dark" = "dark";
const redraws = new Set<() => void>();

/**
 * pi-coding-agent takes over a second to load, all of it blocking the screen,
 * and is needed only to colour code fences. So it loads the first time a
 * fence is drawn: until it lands the fence is drawn in one tone, and every
 * `onHighlighterLoaded` callback then redraws it in colour.
 */
export function loadHighlighter(): Promise<void> {
  loading ??= import("@earendil-works/pi-coding-agent").then((loaded) => {
    loaded.initTheme(register);
    highlighter = loaded;
    for (const redraw of redraws) redraw();
  });
  return loading;
}

/** Call `redraw` once the highlighter has loaded; returns how to stop. */
export function onHighlighterLoaded(redraw: () => void): () => void {
  redraws.add(redraw);
  return () => redraws.delete(redraw);
}

export function highlighterLoaded(): boolean {
  return highlighter !== undefined;
}

/**
 * pi-coding-agent keeps its syntax theme in module-global state, with no
 * per-call theme argument. This sets it from this terminal's resolved
 * Catppuccin flavour — at once if the highlighter is loaded, else when it
 * loads — so a code fence's syntax colours sit in the same light-or-dark
 * register as the rest of the screen.
 */
export function ensureHighlightTheme(colours: Colours): void {
  register = colours.flavour === "latte" ? "light" : "dark";
  highlighter?.initTheme(register);
}

/**
 * pi-tui 0.86.1's `Markdown` mis-renders `###` and deeper headings: h1 and h2
 * strip their `#` markers correctly, but from h3 down it emits the literal
 * hashes as a second, separately heading-styled run ahead of the title (e.g.
 * "### Title" renders as two heading segments, "### " then "Title", instead
 * of one). Flattening anything past h2 down to h2 — before pi-tui ever
 * tokenizes it — avoids the bug outright; a chat reply has no real use for
 * four levels of heading nesting anyway. Pass this as a `Markdown` instance's
 * `options.transform`.
 */
export function demoteDeepHeadings(markdown: string): string {
  return markdown.replace(/^(#{3,6})(\s)/gm, "##$2");
}

/** A pi-tui `MarkdownTheme` painted with this terminal's Catppuccin roles. */
export function markdownTheme(colours: Colours): MarkdownTheme {
  const bold = (text: string) => colours.style("bold", text);
  const italic = (text: string) => colours.style("italic", text);
  const underline = (text: string) => colours.style("underline", text);
  const strikethrough = (text: string) => colours.style("strike", text);
  return {
    heading: (text) => bold(colours.paint("accent", text)),
    link: (text) => underline(colours.paint("accent2", text)),
    linkUrl: (text) => colours.paint("faint", text),
    code: (text) => colours.paint("accent2", text),
    // Only reached when `highlightCode` cannot lex a fence's language; the
    // highlighted path below is what most code actually takes.
    codeBlock: (text) => colours.paint("text", text),
    // pi-tui calls this with the opening fence (```ts) and the closing one.
    // A raw fence is markup, not something to read; a code block is instead
    // a bar down its left edge with the language on top, the way it is set in
    // the desktop app.
    codeBlockBorder: (text) => {
      const fence = /^```(\S*)$/.exec(text);
      if (!fence) return colours.paint("line", text);
      return colours.paint("line", fence[1] ? `╭─ ${fence[1]}` : "╰─");
    },
    codeBlockIndent: `${colours.paint("line", "│")} `,
    quote: (text) => italic(colours.paint("muted", text)),
    quoteBorder: (text) => colours.paint("line", text),
    hr: (text) => colours.paint("line", text),
    listBullet: (text) => colours.paint("accent", text),
    bold: (text) => bold(text),
    italic: (text) => italic(text),
    strikethrough: (text) => strikethrough(text),
    underline: (text) => underline(text),
    // pi-coding-agent's own highlighter: real syntax colour per token instead
    // of one flat tone for the whole fence, which is the raw-text complaint
    // this spike exists to fix. It paints with pi-coding-agent's own theme
    // (set once by `ensureHighlightTheme`), not this file's Catppuccin roles.
    highlightCode: (code, lang) => {
      if (highlighter) return highlighter.highlightCode(code, lang);
      void loadHighlighter().catch(() => undefined);
      return code.split("\n").map((line) => colours.paint("text", line));
    },
  };
}
