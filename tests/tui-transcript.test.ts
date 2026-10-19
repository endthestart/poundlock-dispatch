/**
 * The componentised transcript, driven directly with no TUI and no terminal —
 * `TranscriptView` only needs a `MarkdownTheme` and a `Colours`, both plain
 * values. The one property worth a dedicated test is the day-1 gate item
 * render.ts's own tests cannot see: a streaming draft has to come out of
 * `render` in exactly the same shape as the finished message that replaces
 * it, because `ManagerMessageRow` — and the `demoteDeepHeadings` transform it
 * applies — is the same class either way.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ChatMessage } from "@shared/types";
import { createColours } from "@tui/colour";
import { ensureHighlightTheme, markdownTheme } from "@tui/markdown-theme";
import { TranscriptView } from "@tui/transcript";
import { describe, expect, it } from "vitest";

const colours = createColours({ theme: "mocha", isTTY: false, env: {} });
ensureHighlightTheme(colours);
const theme = markdownTheme(colours);

const WIDTH = 80;

function view(): TranscriptView {
  return new TranscriptView(theme, colours);
}

describe("TranscriptView", () => {
  it("renders a streaming draft exactly as it will render the finished message", () => {
    const text = "## Recap\n\nA `git` check is queued. See the plan below.";

    const streaming = view();
    streaming.sync([], text);
    const draftLines = streaming.render(WIDTH);

    const finished = view();
    finished.sync([{ id: "m1", role: "manager", text, createdAt: "" } as ChatMessage], undefined);
    const finalLines = finished.render(WIDTH);

    expect(draftLines).toEqual(finalLines);
  });

  it("adds a row for a new message id and leaves the rest alone", () => {
    const transcript = view();
    const first: ChatMessage = { id: "m1", role: "user", text: "hi", createdAt: "" };
    transcript.sync([first], undefined);
    const before = transcript.render(WIDTH);

    const second: ChatMessage = { id: "m2", role: "manager", text: "hello", createdAt: "" };
    transcript.sync([first, second], undefined);
    const after = transcript.render(WIDTH);

    // Everything rendered for the first message is still there, unchanged,
    // with the new row appended after it.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("drops a row once its message is gone", () => {
    const transcript = view();
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", text: "hi", createdAt: "" },
      { id: "m2", role: "manager", text: "hello", createdAt: "" },
    ];
    transcript.sync(messages, undefined);
    expect(transcript.render(WIDTH).join("\n")).toContain("hello");

    transcript.sync([messages[0]], undefined);
    expect(transcript.render(WIDTH).join("\n")).not.toContain("hello");
  });

  it("marks a user message's first line as an OSC 133 prompt start", () => {
    // What `tui.altScreen.previousPrompt`/`nextPrompt` look for. A zero-width
    // marker, so it never shows up as visible text.
    const transcript = view();
    transcript.sync(
      [{ id: "m1", role: "user", text: "build it", createdAt: "" } as ChatMessage],
      undefined,
    );
    const [first] = transcript.render(WIDTH);
    expect(first.startsWith("\x1b]133;A\x07")).toBe(true);
  });

  it("sets a notice apart with a bar down its left edge, on every line it wraps to", () => {
    const transcript = view();
    transcript.sync(
      [
        {
          id: "n1",
          role: "system",
          text: "Full access: started without an Approve click, because it is within the limits.",
          createdAt: "",
          kind: "notice",
        } as ChatMessage,
      ],
      undefined,
    );
    const lines = transcript.render(40).filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith("▎ ")).toBe(true);
  });

  it("draws a code fence as a bar with its language on top, not as raw backticks", () => {
    const transcript = view();
    transcript.sync(
      [
        {
          id: "m1",
          role: "manager",
          text: "Run:\n\n```sh\nnpm test\n```\n\nThen stop.",
          createdAt: "",
        } as ChatMessage,
      ],
      undefined,
    );
    // The syntax highlighter colours the code itself; the frame is what is asserted.
    const rendered = stripTerminalSequences(transcript.render(WIDTH).join("\n"));
    expect(rendered).not.toContain("```");
    expect(rendered).toContain("╭─ sh");
    expect(rendered).toMatch(/│ .*npm test/);
    expect(rendered).toContain("╰─");
  });
});
