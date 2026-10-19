import {
  changedRange,
  editableText,
  excerpt,
  fenced,
  locate,
  looseLine,
  nearestRegion,
} from "@runtime/edit-match";
import { describe, expect, it } from "vitest";

const source = [
  "def load(path):",
  "    with open(path) as handle:",
  "        return handle.read()",
  "",
  "",
  "def save(path, text):",
  "    with open(path, 'w') as handle:",
  "        handle.write(text)",
  "",
].join("\n");

describe("edit text analysis", () => {
  it("reads text the way Pi matches it", () => {
    expect(editableText("\uFEFFa\r\nb\rc")).toBe("a\nb\nc");
    expect(looseLine("\t  x  =   \u201Cy\u201D \u2014 z  ")).toBe('x = "y" - z');
  });

  it("locates text exactly, then apart from whitespace", () => {
    expect(locate(source, "        return handle.read()\n")).toEqual([
      { range: { start: 3, end: 3 }, exact: true },
    ]);
    expect(locate(source, "handle.read()")).toEqual([{ range: { start: 3, end: 3 }, exact: true }]);
    expect(locate(source, "def save(path, text):\n  with open(path, 'w') as handle:")).toEqual([
      { range: { start: 6, end: 7 }, exact: false },
    ]);
    expect(locate(source, "with open(path")).toHaveLength(2);
    expect(locate(source, "\n\n")).toEqual([]);
    expect(locate(source, "def missing():")).toEqual([]);
  });

  it("finds a region that differs only in indentation, and says where", () => {
    const near = nearestRegion(
      source,
      "def save(path, text):\n        with open(path, 'w') as handle:",
    );
    expect(near).toMatchObject({
      range: { start: 6, end: 7 },
      score: 1,
      whitespaceOnly: true,
      difference: {
        line: 7,
        file: "    with open(path, 'w') as handle:",
        old: "        with open(path, 'w') as handle:",
      },
    });
  });

  it("finds a misquoted region and its first differing line", () => {
    const near = nearestRegion(
      source,
      "def save(path, data):\n    with open(path, 'w') as handle:",
    );
    expect(near?.range).toEqual({ start: 6, end: 7 });
    expect(near?.whitespaceOnly).toBe(false);
    expect(near?.score).toBeGreaterThan(0.8);
    expect(near?.difference).toEqual({
      line: 6,
      file: "def save(path, text):",
      old: "def save(path, data):",
    });
    // No line survives intact: anchored on similarity instead.
    expect(nearestRegion(source, "        return handle.reads()")?.range).toEqual({
      start: 3,
      end: 3,
    });
  });

  it("returns nothing when no region is similar", () => {
    expect(nearestRegion(source, "class Widget(Base):\n    pass")).toBeUndefined();
    expect(nearestRegion(source, "\n\n")).toBeUndefined();
    expect(nearestRegion("", "anything")).toBeUndefined();
  });

  it("stays bounded on a large file", () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `    value_${i} = compute(${i})`).join(
      "\n",
    );
    const started = performance.now();
    const near = nearestRegion(
      big,
      "    value_12345 = compute(12346)\n    value_12346 = compute(12346)",
    );
    expect(near?.range).toEqual({ start: 12346, end: 12347 });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("says which lines changed on disk", () => {
    expect(changedRange("a\nb\nc\n", "a\nb\nc\n")).toBeUndefined();
    expect(changedRange("a\nb\nc\n", "a\nB\nc\n")).toEqual({
      range: { start: 2, end: 2 },
      lines: 3,
    });
    expect(changedRange("a\nb\nc\nd\n", "a\nb2\nc2\nd\n")).toEqual({
      range: { start: 2, end: 3 },
      lines: 4,
    });
    // A deletion points at the line after it; an append at the new line.
    expect(changedRange("a\nb\nc\n", "a\nc\n")?.range).toEqual({ start: 2, end: 2 });
    expect(changedRange("a\n", "a\nb\n")?.range).toEqual({ start: 2, end: 2 });
  });

  it("excerpts verbatim, with context, within bounds", () => {
    expect(excerpt(source, { start: 3, end: 3 })).toEqual({
      range: { start: 1, end: 5 },
      text: source.split("\n").slice(0, 5).join("\n"),
      cut: false,
    });
    const long = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"x".repeat(150)}`).join(
      "\n",
    );
    const shown = excerpt(long, { start: 10, end: 190 });
    expect(shown.cut).toBe(true);
    expect(shown.range.start).toBe(8);
    expect(shown.text.length).toBeLessThanOrEqual(3_000);
    expect(shown.text.split("\n")).toHaveLength(shown.range.end - shown.range.start + 1);
  });

  it("fences text that itself holds a fence", () => {
    expect(fenced("plain")).toBe("```\nplain\n```");
    expect(fenced("```js\nx\n```")).toBe("````\n```js\nx\n```\n````");
  });
});
