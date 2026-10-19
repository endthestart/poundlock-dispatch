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
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { Colours } from "./colour.js";

/**
 * pi-coding-agent keeps its own syntax theme in module-global state: `theme`
 * is a `Proxy` that throws "Theme not initialized" until `initTheme` has run
 * once, and `highlightCode` reads through it. There is no per-call theme
 * argument, so this has to run once at startup — see `index.ts` — before
 * anything calls `highlightCode` or builds a `MarkdownTheme` with one.
 *
 * It picks pi-coding-agent's own light/dark theme from this terminal's
 * resolved Catppuccin flavour, so a code fence's syntax colours sit in the
 * same light-or-dark register as the rest of the screen rather than guessing
 * independently from the terminal background a second time.
 */
export function ensureHighlightTheme(colours: Colours): void {
  initTheme(colours.flavour === "latte" ? "light" : "dark");
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
    highlightCode: (code, lang) => highlightCode(code, lang),
  };
}
