/**
 * The pieces every terminal screen is laid out from. They are all measured in
 * terminal columns, so the properties worth holding are about width: nothing
 * comes out wider than it was told, and nothing is cut in the middle of a word
 * it could have kept whole.
 */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  chip,
  clip,
  fitParts,
  frame,
  gutter,
  joinParts,
  keyHints,
  labelled,
  padTo,
  rule,
  spread,
  wrap,
  wrapExact,
} from "@tui/chrome";
import { createColours, PLAIN } from "@tui/colour";
import { describe, expect, it } from "vitest";

const colour = createColours({ theme: "mocha", isTTY: true, env: { COLORTERM: "truecolor" } });
const plain = (text: string) => stripTerminalSequences(text);

describe("clip and padTo", () => {
  it("leaves a line that fits, and ends one that does not in an ellipsis", () => {
    expect(clip("short", 20)).toBe("short");
    const cut = clip("a considerably longer line", 12);
    expect(plain(cut).endsWith("…")).toBe(true);
    expect(visibleWidth(cut)).toBe(12);
    expect(clip("anything", 0)).toBe("");
  });

  it("measures colour and wide characters as the columns they take", () => {
    const styled = colour.paint("accent", "hello world");
    expect(visibleWidth(clip(styled, 5))).toBeLessThanOrEqual(5);
    expect(visibleWidth(padTo(styled, 20))).toBe(20);
    expect(visibleWidth(padTo("日本語", 10))).toBe(10);
  });
});

describe("spread", () => {
  it("puts one thing at each edge of the line", () => {
    const line = spread("left", "right", 30);
    expect(line.startsWith("left")).toBe(true);
    expect(line.endsWith("right")).toBe(true);
    expect(visibleWidth(line)).toBe(30);
  });

  it("gives up the right side, not half of the left, when both cannot fit", () => {
    expect(spread("a fairly long left side", "right", 26)).toBe("a fairly long left side");
    expect(visibleWidth(spread("a fairly long left side", "right", 10))).toBeLessThanOrEqual(10);
  });
});

describe("wrap", () => {
  it("keeps paragraphs apart and starts every line with the indent", () => {
    expect(wrap("one two\n\nthree", 20)).toEqual(["one two", "", "three"]);
    expect(wrap("alpha beta gamma", 12, "  ")).toEqual(["  alpha beta", "  gamma"]);
  });

  it("never returns a line wider than asked, even for one long token", () => {
    const path = "/Users/someone/Development/a-project/with/a/very/deep/tree/of/folders/file.ts";
    for (const width of [10, 24, 40, 80]) {
      const lines = wrap(`Open ${path} now`, width);
      for (const line of lines)
        expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
      // Nothing is lost by breaking it.
      expect(lines.join("").replace(/\s/g, "")).toBe(`Open${path}now`);
    }
  });

  it("counts a wide character as two columns", () => {
    for (const line of wrap("日本語のテキストを折り返す テスト", 10))
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
  });

  it("does not choke on a width narrower than a word, or on nothing", () => {
    expect(wrap("word", 0).join("")).toBe("word");
    expect(wrap("", 20)).toEqual([""]);
  });
});

describe("wrapExact", () => {
  it("keeps every run of spaces and every line break, and only moves where a line is cut", () => {
    expect(wrapExact("a   b\n\n  c", 40)).toEqual(["a   b", "", "  c"]);
    expect(wrapExact("one two three four", 9, "> ")).toEqual(["> one two", "> three", "> four"]);
  });

  it("never returns a line wider than asked", () => {
    for (const width of [8, 20, 40])
      for (const line of wrapExact(`${"x".repeat(90)} and a few   ordinary words`, width, "  "))
        expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
  });
});

describe("rule", () => {
  it("is exactly as wide as asked, with or without a label", () => {
    for (const width of [10, 40, 100]) {
      expect(visibleWidth(rule(width))).toBe(width);
      expect(visibleWidth(rule(width, "tasks"))).toBe(width);
    }
    expect(plain(rule(20, "tasks"))).toBe("── tasks ───────────");
  });

  it("paints only the label in the role, leaving the dashes quiet", () => {
    const painted = rule(20, "tasks", colour, "review");
    expect(painted).toContain(colour.paint("review", " tasks "));
    expect(plain(painted)).toBe(rule(20, "tasks"));
  });

  it("cuts a label that is wider than the rule", () => {
    expect(visibleWidth(rule(12, "a label far too long for this"))).toBe(12);
  });
});

describe("keyHints", () => {
  const hints = [
    { key: "Enter", label: "send" },
    { key: "/", label: "commands" },
    { key: "Tab", label: "board" },
    { key: "Ctrl+C", label: "exit" },
  ];

  it("names each key and what it does, in order", () => {
    expect(plain(keyHints(colour, hints, 100))).toBe(
      "Enter send · / commands · Tab board · Ctrl+C exit",
    );
    expect(keyHints(PLAIN, hints, 100)).toBe("Enter send · / commands · Tab board · Ctrl+C exit");
  });

  it("drops the last hints, whole, rather than cut one in half", () => {
    for (const width of [50, 40, 30, 20, 12]) {
      const line = plain(keyHints(colour, hints, width));
      expect(visibleWidth(line), `${width}`).toBeLessThanOrEqual(width);
      // Whatever survives is a prefix of the full list, so no half-hint teaches the wrong key.
      expect("Enter send · / commands · Tab board · Ctrl+C exit".startsWith(line)).toBe(true);
    }
    expect(plain(keyHints(colour, hints, 30))).toBe("Enter send · / commands");
  });

  it("keeps the key in the accent so it is the part noticed", () => {
    expect(keyHints(colour, hints, 100)).toContain(colour.paint("accent", "Enter"));
  });
});

describe("fitParts", () => {
  const parts = [
    { text: "project", rank: 2 },
    { text: "mgr alpha", rank: 0 },
    { text: "wrk beta", rank: 3 },
    { text: "$4.12 left", rank: 1 },
  ];

  it("drops the least important part, not the last one", () => {
    const kept = fitParts(parts, 30, "  ·  ").map((part) => part.text);
    expect(kept).toContain("$4.12 left");
    expect(kept).not.toContain("wrk beta");
  });

  it("keeps what remains in the order it was given", () => {
    const kept = fitParts(parts, 100, "  ·  ").map((part) => part.text);
    expect(kept).toEqual(["project", "mgr alpha", "wrk beta", "$4.12 left"]);
    const fewer = fitParts(parts, 32, "  ·  ").map((part) => part.text);
    expect(fewer).toEqual(["mgr alpha", "$4.12 left"]);
  });

  it("keeps one part however narrow the line, and clips it when joined", () => {
    const kept = fitParts(parts, 3, "  ·  ");
    expect(kept.map((part) => part.text)).toEqual(["mgr alpha"]);
    expect(visibleWidth(joinParts(PLAIN, kept, 3, "  ·  "))).toBeLessThanOrEqual(3);
  });

  it("measures on the plain text and paints the styled one", () => {
    const styled = [{ text: "mgr alpha", styled: colour.paint("faint", "mgr alpha"), rank: 0 }];
    expect(joinParts(colour, styled, 20, " · ")).toBe(colour.paint("faint", "mgr alpha"));
  });
});

describe("labelled", () => {
  it("lines the values up and hangs a wrapped value under itself", () => {
    const lines = labelled(PLAIN, "Scope", "one two three four five six seven", 26, 5);
    expect(lines[0]).toBe("Scope  one two three four");
    expect(lines[1]).toBe("       five six seven");
  });

  it("paints the value, not the label, when given a role", () => {
    const [line] = labelled(colour, "Token", "missing", 40, 5, "fault");
    expect(line).toContain(colour.paint("fault", "missing"));
    expect(line).toContain(colour.paint("faint", "Token"));
  });
});

describe("chip", () => {
  it("is a dot and the words, so state is never colour alone", () => {
    expect(chip(PLAIN, "ok", "Completed")).toBe("● Completed");
    expect(plain(chip(colour, "fault", "Failed"))).toBe("● Failed");
  });
});

describe("frame", () => {
  it("is a titled box exactly as wide as it is given, however narrow", () => {
    for (const width of [20, 40, 80, 120]) {
      const box = frame(PLAIN, "accent", "A title", ["one", "two"], width);
      expect(
        box.every((line) => visibleWidth(line) === width),
        `${width}`,
      ).toBe(true);
    }
    const [top, first, , bottom] = frame(PLAIN, "accent", "A title", ["one", "two"], 30);
    expect(top).toMatch(/^╭─ A title ─+╮$/);
    expect(first).toBe(`│ one${" ".repeat(23)} │`);
    expect(bottom).toMatch(/^╰─+╯$/);
  });

  it("clips a line that is wider than the inside instead of pushing the side out", () => {
    const box = frame(PLAIN, "accent", "T", ["x".repeat(200)], 30);
    expect(box.every((line) => visibleWidth(line) === 30)).toBe(true);
  });

  it("cuts a title that is too long", () => {
    const [top] = frame(PLAIN, "accent", "a title much too long for the box", ["x"], 20);
    expect(visibleWidth(top)).toBe(20);
  });
});

describe("gutter", () => {
  it("indents every line and leaves blank lines blank", () => {
    expect(gutter(["a", "", "b"])).toEqual(["  a", "", "  b"]);
  });

  it("keeps a zero-width marker at the very start of its line", () => {
    // The transcript marks each of your messages so the terminal can jump
    // between them; the marker only works as the first thing on the line.
    const marker = `${String.fromCharCode(27)}]133;A${String.fromCharCode(7)}`;
    const [line] = gutter([`${marker}hello`]);
    expect(line.startsWith(marker)).toBe(true);
    expect(plain(line)).toBe("  hello");
  });
});
