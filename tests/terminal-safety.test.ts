/**
 * M9: model and repository text never reaches the terminal with its escape
 * sequences, and an approval card shows them written out.
 */
import { approvalView } from "@shared/approval-view";
import { displaySafe, visibleControls } from "@shared/display-safe";
import type { ToolApproval } from "@shared/permissions";
import type { ChatMessage } from "@shared/types";
import { wrap, wrapExact } from "@tui/chrome";
import { createColours } from "@tui/colour";
import { ensureHighlightTheme, markdownTheme } from "@tui/markdown-theme";
import { approvalCardParts } from "@tui/render";
import { TranscriptView } from "@tui/transcript";
import { describe, expect, it } from "vitest";

const ESC = "\x1b";
const colours = createColours({ theme: "mocha", isTTY: false, env: {} });
ensureHighlightTheme(colours);

/** A command whose harmful part a terminal would hide: erase the line, return, overwrite. */
const hidden = `rm -rf ~/.ssh${ESC}[2K\recho tidy`;

function approval(extra: Partial<ToolApproval> = {}): ToolApproval {
  return {
    id: "a1",
    projectId: "p",
    projectName: "Example",
    planRevision: 1,
    kind: "bash",
    action: hidden,
    reason: `Tidy up${ESC}]52;c;ZWNobyBoaQ==\x07`,
    cwd: "/project",
    displayCommand: hidden,
    createdAt: "now",
    ...extra,
  } as ToolApproval;
}

describe("visible control characters", () => {
  it("writes escapes out instead of passing them to the terminal", () => {
    expect(visibleControls(hidden)).toBe("rm -rf ~/.ssh\\x1b[2K\\recho tidy");
    expect(visibleControls("a‮b\nc\td")).toBe("a\\u{202e}b\nc\td");
    expect(displaySafe(hidden)).not.toContain(ESC);
    expect(displaySafe(hidden)).not.toContain("\r");
  });
});

describe("approval cards", () => {
  it("show the escape bytes of the exact command, reason and requested form", () => {
    const view = approvalView(approval({ requestedCommand: `ls${ESC}[8m secret` }));
    expect(view.exact).toBe("rm -rf ~/.ssh\\x1b[2K\\recho tidy");
    expect(view.reason).toContain("\\x1b]52;c;");
    expect(view.requested).toBe("ls\\x1b[8m secret");
    for (const value of Object.values(view)) {
      expect(String(value)).not.toContain(ESC);
      expect(String(value)).not.toContain("\r");
    }
  });

  it("render in the terminal client with nothing hidden", () => {
    const { facts, exact } = approvalCardParts(approval(), 80);
    const text = [...facts, ...exact].join("\n");
    expect(text).not.toContain(ESC);
    expect(text).toContain("\\x1b[2K\\recho tidy");
  });
});

describe("terminal client text", () => {
  it("wraps text without its escape sequences", () => {
    for (const line of [...wrap(hidden, 40), ...wrapExact(hidden, 40)]) {
      expect(line).not.toContain(ESC);
      expect(line).not.toContain("\r");
    }
  });

  it("renders a manager message without a clipboard write or cursor movement", () => {
    const transcript = new TranscriptView(markdownTheme(colours), colours);
    const text = `Done.${ESC}]52;c;cm0gLXJmIH4=\x07 See ${ESC}[1A${ESC}[2Kthe plan.`;
    transcript.sync(
      [
        { id: "m1", role: "manager", text, createdAt: "" } as ChatMessage,
        { id: "m2", role: "user", text, createdAt: "" } as ChatMessage,
      ],
      text,
    );
    const rendered = transcript.render(80).join("\n");
    expect(rendered).not.toContain(`${ESC}]52;`);
    expect(rendered).not.toContain(`${ESC}[1A`);
    expect(rendered).toContain("Done.");
  });
});
