/**
 * The pinned decision cards: a box that spans exactly the width it is given,
 * says what it is in its top border, keeps a long plan short, and carries its
 * answers inside.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { Card } from "@tui/card";
import { createColours } from "@tui/colour";
import { describe, expect, it } from "vitest";

const plain = createColours({ theme: "mocha", isTTY: false, env: {} });
const truecolour = createColours({ theme: "mocha", isTTY: true, env: { COLORTERM: "truecolor" } });

function lines(count: number) {
  return () => Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

describe("a card", () => {
  it("is a box exactly as wide as it is given, titled in its top border", () => {
    for (const width of [30, 80, 200]) {
      const out = new Card(
        { key: "k", title: "Proposed plan", role: "accent", body: lines(3), footer: "/approve" },
        truecolour,
      ).render(width);
      expect(
        out.every((line) => visibleWidth(line) === width),
        `${width}`,
      ).toBe(true);
    }
    const [top, ...rest] = new Card(
      { key: "k", title: "Proposed plan", role: "accent", body: lines(1) },
      plain,
    ).render(40);
    expect(top).toMatch(/^╭─ Proposed plan ─+╮$/);
    expect(rest.at(-1)).toMatch(/^╰─+╯$/);
    expect(rest[0]).toBe(`│ line 1${" ".repeat(30)} │`);
  });

  it("keeps a long body short and says where the rest is", () => {
    const out = new Card(
      {
        key: "k",
        title: "Proposed plan",
        role: "accent",
        body: lines(30),
        maxBodyLines: 10,
        overflow: "/board for the full plan",
      },
      plain,
    ).render(80);
    expect(out).toHaveLength(12);
    expect(out[10]).toContain("… 21 more lines · /board for the full plan");
  });

  it("colours its border by the kind of decision", () => {
    const [approval] = new Card(
      { key: "a", title: "Decision needed", role: "review", body: lines(1) },
      truecolour,
    ).render(40);
    const [plan] = new Card(
      { key: "p", title: "Plan", role: "accent", body: lines(1) },
      truecolour,
    ).render(40);
    expect(approval).not.toBe(plan);
    const [reviewColour] = truecolour.paint("review", "x").split("x");
    expect(approval.startsWith(reviewColour)).toBe(true);
  });

  it("shows its answers inside the box and keeps the highlight across an update", () => {
    let chosen = "";
    const spec = {
      key: "q",
      title: "The manager is asking",
      role: "accent2" as const,
      body: lines(1),
      choices: {
        items: [
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ],
        onSelect: (item: { value: string }) => {
          chosen = item.value;
        },
      },
    };
    const card = new Card(spec, plain);
    expect(card.render(40).some((line) => line.includes("→ One"))).toBe(true);
    card.handleInput("\x1b[B");
    card.update({ ...spec, body: lines(2) });
    card.handleInput("\r");
    expect(chosen).toBe("two");
  });
});
