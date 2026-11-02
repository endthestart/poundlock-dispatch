/** The plain transcript and the text pieces every screen shares: headings, bullets and command mentions. */

import { type ChatMessage } from "@shared/types";
import { rule, spread, wrap } from "./chrome.js";
import { type Colours } from "./colour.js";
import { COMMAND_DEFS } from "./commands.js";
import { messageHead } from "./message-head.js";

export const KEY_HINTS = {
  allowOnce: "a",
  allowAlways: "s",
  deny: "d",
  tasks: "tab",
  commands: "/",
} as const;

/** The widest a message of yours gets before it wraps, as a share of the terminal. */
export const OWN_MESSAGE_SHARE = 0.62;

/** A screen's lines, and the one line that says what the composer will do. */
export interface Screen {
  lines: string[];
  hint: string;
}

/**
 * The plain transcript, with your own words set apart from the manager's.
 * This is the version a pipe gets; the terminal draws the same shape from
 * `transcript.ts`, with markdown.
 *
 * Every line used to carry an eight-column speaker gutter — `manager` once
 * and eight spaces on every wrapped line after it — which spent a tenth of
 * the terminal restating the obvious. The manager is the default voice here
 * and needs no label; what needs marking is the line you wrote.
 *
 * Your messages are set as a block against the right margin, left-aligned
 * inside it, the way a chat client does. True right-alignment would ragged
 * the left edge of anything that wrapped, which is the edge you read from.
 */
export function renderTranscript(
  messages: ChatMessage[],
  width: number,
  /** The manager's reply so far, when a turn is still running. */
  draft?: string,
): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const block = Math.max(20, Math.floor(width * OWN_MESSAGE_SHARE));
      const body = wrap(message.text, block - 2);
      const longest = Math.max(...body.map((line) => line.length), 0);
      const indent = " ".repeat(Math.max(0, width - longest - 2));
      const head = messageHead(message);
      lines.push(`${" ".repeat(Math.max(0, width - head.length))}${head}`);
      for (const line of body) lines.push(`${indent}▏ ${line}`);
      lines.push("");
      continue;
    }
    // The manager speaks flush left, unmarked; anything else is machinery and
    // says so with a mark rather than a word.
    const marker = message.role === "manager" ? "" : "· ";
    if (message.role === "manager") lines.push(messageHead(message));
    const body = wrap(message.text, width - marker.length);
    for (const [index, line] of body.entries())
      lines.push(index === 0 ? `${marker}${line}` : `${" ".repeat(marker.length)}${line}`);
    if (message.toolTrace?.length) {
      const used = message.toolTrace.map((tool) => (tool.error ? `${tool.name}!` : tool.name));
      lines.push(`· ${used.join(", ")}`);
    }
    lines.push("");
  }
  // Laid out exactly like a finished manager message, because it is going to
  // become one. A different shape here would make the text appear to move when
  // the turn ends.
  if (draft?.trim()) {
    lines.push(messageHead({ createdAt: "" }));
    for (const line of wrap(draft, width)) lines.push(line);
    lines.push("");
  }
  return lines;
}

/** The slash commands that exist, longest first so `/approve-models` is never read as `/approve`. */
const COMMAND_MENTION = new RegExp(
  `(^|[\\s(])(${COMMAND_DEFS.map((command) => command.name)
    .sort((a, b) => b.length - a.length)
    .join("|")})(?![\\w-])`,
  "g",
);

/**
 * A command named inside running text, set apart so it can be found again.
 * Only commands that exist: a path that happens to start with a slash is not
 * one, and painting it as one would be a small lie.
 */
export function withCommands(colours: Colours, text: string): string {
  return text.replace(
    COMMAND_MENTION,
    (_match, before: string, command: string) => `${before}${colours.paint("accent", command)}`,
  );
}

/** A section's title and a quiet aside, above a rule. */
export function heading(colours: Colours, title: string, aside: string | undefined, width: number) {
  const left = colours.style("bold", colours.paint("accent", title));
  const right = aside ? colours.paint("faint", aside) : "";
  return [spread(left, right, width), rule(width, undefined, colours)];
}

/** A small heading inside a section: `Acceptance criteria`. */
export function subheading(colours: Colours, text: string): string {
  return colours.style("bold", colours.paint("muted", text));
}

/** A list with hanging indents, so a wrapped item stays under its own first word. */
export function bulleted(colours: Colours, items: string[], width: number, marker = "•"): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const body = wrap(item, Math.max(1, width - 4));
    for (const [index, line] of body.entries())
      lines.push(index === 0 ? `  ${colours.paint("faint", marker)} ${line}` : `    ${line}`);
  }
  return lines;
}
