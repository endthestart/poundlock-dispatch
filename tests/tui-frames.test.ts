/**
 * The boxes the terminal client draws things in: the composer, a decision
 * card, a picker and a prompt. What matters about a box is that it is exactly
 * as wide as it is given, says what it is in its top edge, and never hides
 * the thing it exists to show.
 */
import {
  CombinedAutocompleteProvider,
  type SelectList,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { BoxedEditor } from "@tui/boxed-editor";
import { Card } from "@tui/card";
import { createColours, PLAIN } from "@tui/colour";
import { COMMAND_DEFS, toSlashCommands } from "@tui/commands";
import { showPicker } from "@tui/picker";
import { showPrompt } from "@tui/prompt";
import { describe, expect, it, vi } from "vitest";

const colour = createColours({ theme: "mocha", isTTY: true, env: { COLORTERM: "truecolor" } });
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
const ESC = String.fromCharCode(27);

function editorTui(rows = 40) {
  return { terminal: { rows, columns: 100 }, requestRender: () => undefined } as unknown as TUI;
}

function composer(paintBorder?: (text: string) => string) {
  const theme = {
    borderColor: (text: string) => text,
    selectList: {
      selectedPrefix: (text: string) => text,
      selectedText: (text: string) => text,
      description: (text: string) => text,
      scrollInfo: (text: string) => text,
      noMatch: (text: string) => text,
    },
  };
  return new BoxedEditor(editorTui(), theme, paintBorder);
}

describe("the composer's box", () => {
  it("is as wide as it is given on every line, with its label set into the top edge", () => {
    const box = composer();
    box.setTitle("Ask the Project Manager");
    for (const width of [30, 80, 120]) {
      const lines = box.render(width);
      expect(lines).toHaveLength(3);
      expect(
        lines.every((line) => visibleWidth(line) === width),
        `${width}`,
      ).toBe(true);
      expect(lines[0]).toMatch(/^╭─ Ask the Project Manager ─+╮$/);
      expect(lines[2]).toMatch(/^╰─+╯$/);
    }
  });

  it("asks for a shorter label when the edge is narrow, and cuts one that still will not fit", () => {
    const box = composer();
    box.setTitle((room) => (room >= 40 ? "A long label that needs room" : "Short"));
    expect(box.render(80)[0]).toContain("A long label that needs room");
    expect(box.render(30)[0]).toContain("─ Short ─");
    box.setTitle("A label far too long to fit in a very narrow box at all");
    expect(visibleWidth(box.render(24)[0])).toBe(24);
  });

  it("draws a plain rule when there is no label", () => {
    expect(composer().render(20)[0]).toBe("╭──────────────────╮");
  });

  it("leaves the editor's own scroll indicator where it put it, rather than a label over it", () => {
    const box = composer();
    box.setTitle("A label");
    box.focused = true;
    box.setText(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
    const [top, ...rest] = box.render(60);
    expect(top).toMatch(/↑ \d+ more/);
    expect(top).not.toContain("A label");
    expect(rest.at(-1)).toMatch(/^╰/);
  });

  it("puts a line of keys under the box, given the width inside it", () => {
    const box = composer();
    const asked: number[] = [];
    box.setFooter((inner) => {
      asked.push(inner);
      return "Enter send · / commands";
    });
    const lines = box.render(60);
    expect(lines.at(-1)).toBe("  Enter send · / commands");
    expect(lines).toHaveLength(4);
    expect(asked).toContain(56);
  });

  it("shows the slash-command menu below the box, in place of the keys, not inside it", async () => {
    const box = composer();
    box.setFooter("KEYS");
    box.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(toSlashCommands(COMMAND_DEFS), process.cwd()),
    );
    box.focused = true;
    box.handleInput("/");
    await vi.waitFor(() => expect(plain(box.render(80)).join("\n")).toContain("Show the plan"));
    const lines = plain(box.render(80));
    const bottom = lines.findIndex((line) => line.startsWith("╰"));
    expect(lines.slice(0, bottom + 1).join("\n")).not.toContain("Show the plan");
    expect(lines.slice(bottom + 1).join("\n")).toContain("Show the plan");
    expect(lines.join("\n")).not.toContain("KEYS");
    // The box itself is still whole: a top, a line of text, a bottom.
    expect(lines.slice(0, bottom + 1)).toHaveLength(3);
  });

  it("does not draw a cursor in a box that does not have the keyboard", () => {
    const box = composer();
    box.focused = true;
    expect(box.render(40).join("")).toContain(`${ESC}[7m`);
    box.focused = false;
    expect(box.render(40).join("")).not.toContain(`${ESC}[7m`);
    // The line is the same width either way, so nothing shifts when focus moves.
    expect(visibleWidth(box.render(40)[1])).toBe(40);
  });

  it("asks for its border colour every time it draws, so it can change with focus", () => {
    let role = "one";
    const box = composer((text) => `<${role}>${text}</${role}>`);
    const first = box.render(20).join("");
    role = "two";
    const second = box.render(20).join("");
    expect(first).toContain("<one>");
    expect(second).toContain("<two>");
  });
});

describe("a card's box", () => {
  const lines = (count: number, prefix = "line") =>
    Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

  it("never cuts the lines it was told to pin, however short the room", () => {
    const card = new Card(
      {
        key: "k",
        title: "Decision needed",
        role: "review",
        body: () => lines(30),
        pinned: () => ["", "npm test"],
        maxHeight: 10,
        choices: {
          items: [
            { value: "once", label: "Allow once" },
            { value: "deny", label: "Deny" },
          ],
          onSelect: () => undefined,
        },
        footer: "keys",
      },
      PLAIN,
    );
    const out = card.render(60).join("\n");
    expect(out).toContain("npm test");
    expect(out).toContain("Allow once");
    expect(out).toContain("keys");
    expect(out).toMatch(/… \d+ more lines/);
  });

  it("keeps its blank lines while the whole body fits, and gives them up before cutting the body", () => {
    const spec = (body: number, maxHeight: number) => ({
      key: "k",
      title: "T",
      role: "accent" as const,
      body: () => lines(body),
      pinned: () => ["", "the command"],
      maxHeight,
      footer: "keys",
    });
    // 4 body + pinned (2) + footer (2 with its blank line) + borders (2) = 10.
    const roomy = new Card(spec(4, 10), PLAIN).render(60);
    expect(roomy).toHaveLength(10);
    expect(roomy.filter((line) => line.replace(/[│ ]/g, "") === "")).toHaveLength(2);
    // One line short: the footer's blank goes, and every line of the body stays.
    const tight = new Card(spec(4, 9), PLAIN).render(60);
    expect(tight.join("\n")).toContain("line 4");
    expect(tight).toHaveLength(9);
  });

  it("gives the footer the width inside the box", () => {
    const seen: number[] = [];
    new Card(
      {
        key: "k",
        title: "T",
        role: "accent",
        body: () => ["x"],
        footer: (inner) => {
          seen.push(inner);
          return "keys";
        },
      },
      PLAIN,
    ).render(50);
    expect(seen).toEqual([46]);
  });

  it("makes room for the longest answer, so none is cut while the box is wide enough", () => {
    const label = "Remember this exact command in this folder";
    const card = new Card(
      {
        key: "k",
        title: "T",
        role: "review",
        body: () => ["x"],
        choices: {
          items: [
            { value: "once", label: "Allow once", description: "[a]" },
            { value: "always", label: label, description: "[s]" },
          ],
          onSelect: () => undefined,
        },
      },
      PLAIN,
    );
    expect(card.render(80).join("\n")).toContain(label);
  });

  it("is exactly as wide as it is given, colour or none, whatever the body holds", () => {
    for (const colours of [PLAIN, colour])
      for (const width of [20, 40, 100]) {
        const out = new Card(
          {
            key: "k",
            title: "A rather long title for a narrow box",
            role: "accent2",
            body: () => ["x".repeat(300), "short"],
            footer: "y".repeat(300),
          },
          colours,
        ).render(width);
        expect(
          out.every((line) => visibleWidth(line) === width),
          `${width}`,
        ).toBe(true);
      }
  });
});

/** A terminal that keeps the last overlay it was asked to show, and nothing else. */
function overlayTui() {
  let component: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
  const tui = {
    showOverlay: (shown: typeof component) => {
      component = shown;
      return { hide: () => undefined };
    },
  } as unknown as TUI;
  return { tui, overlay: () => component! };
}

describe("a picker's box", () => {
  const items = [
    {
      value: "ask",
      label: "Ask for approval",
      description:
        "Ask before a local sub-agent runs a shell command, uses the network or writes outside the project.",
    },
    {
      value: "assist",
      label: "Approve for me",
      description: "Allow project setup, edits and tests.",
    },
    { value: "full", label: "Full access" },
  ];

  it("is titled and names the keys that choose", () => {
    const { tui, overlay } = overlayTui();
    void showPicker(tui, PLAIN, items, { title: "Worker permissions" });
    const lines = overlay().render(80);
    expect(lines[0]).toMatch(/^╭─ Worker permissions ─+╮$/);
    expect(lines.join("\n")).toContain("↑↓ choose · Enter select · Esc cancel");
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
  });

  it("says in full what the highlighted item means, and follows the highlight", () => {
    const { tui, overlay } = overlayTui();
    void showPicker(tui, PLAIN, items, { title: "T" });
    const said = (lines: string[]) =>
      lines
        .join(" ")
        .replace(/[│╭╮╰╯─]/g, " ")
        .replace(/\s+/g, " ");
    const first = overlay().render(60).join("\n");
    expect(said(overlay().render(60))).toContain(
      "Ask before a local sub-agent runs a shell command, uses the network or writes outside the project.",
    );
    // Nothing is cut at the edge of the list: no half of a description beside a label.
    expect(first).not.toMatch(/Ask for approval +Ask before/);
    overlay().handleInput?.("\x1b[B");
    const second = overlay().render(60).join("\n");
    expect(second).toContain("Allow project setup, edits and tests.");
    expect(second).not.toContain("Ask before a local sub-agent");
  });

  it("keeps its height as the highlight moves, so the box does not jump", () => {
    const { tui, overlay } = overlayTui();
    void showPicker(tui, PLAIN, items, { title: "T" });
    const heights = new Set<number>();
    for (let step = 0; step < 4; step++) {
      heights.add(overlay().render(60).length);
      overlay().handleInput?.("\x1b[B");
    }
    expect(heights.size).toBe(1);
  });

  it("resolves with the chosen item, and with nothing on Escape", async () => {
    const chosen = overlayTui();
    const picked = showPicker(chosen.tui, PLAIN, items, { title: "T" });
    chosen.overlay().handleInput?.("\x1b[B");
    chosen.overlay().handleInput?.("\r");
    expect((await picked)?.value).toBe("assist");

    const cancelled = overlayTui();
    const none = showPicker(cancelled.tui, PLAIN, items, { title: "T" });
    (cancelled.overlay() as unknown as SelectList).handleInput("\x1b");
    expect(await none).toBeUndefined();
  });
});

describe("a prompt's box", () => {
  it("is titled with its step, wraps what it explains, and names its keys", () => {
    const { tui, overlay } = overlayTui();
    void showPrompt(tui, PLAIN, {
      title: "Application token",
      step: "2 of 2",
      detail: [
        "One application token from Poundlock Access. Stored only on this computer, never shown.",
      ],
      secret: true,
    });
    const lines = overlay().render(50);
    expect(lines[0]).toMatch(/^╭─ Application token · 2 of 2 ─+╮$/);
    expect(lines.join("\n")).toContain("Enter confirm · Esc cancel");
    expect(lines.every((line) => visibleWidth(line) === 50)).toBe(true);
    expect(lines.length).toBeGreaterThan(6);
  });
});
