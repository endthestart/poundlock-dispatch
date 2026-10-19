/**
 * The TUI's colour layer: capability detection, the per-flavour palette and
 * how it is squeezed into 256 and 16 colours. That the renderers give back
 * their plain text once the colour is stripped is checked where the renderers
 * are (tests/tui-render.test.ts and tests/tui-views.test.ts).
 */
import { describe, expect, it } from "vitest";
import themeDoc from "../src/shared/theme.json";
import {
  createColours,
  PLAIN,
  resolveColourMode,
  resolveFlavour,
  rgbToAnsi256,
  roleForTone,
  systemFlavourFromEnv,
} from "../src/tui/colour";

describe("resolveColourMode", () => {
  it("is plain when NO_COLOR is set, regardless of TTY or COLORTERM", () => {
    expect(resolveColourMode({ isTTY: true, env: { NO_COLOR: "1" } })).toBe("none");
    expect(resolveColourMode({ isTTY: true, env: { NO_COLOR: "" } })).toBe("none");
    expect(resolveColourMode({ isTTY: true, env: { NO_COLOR: "1", COLORTERM: "truecolor" } })).toBe(
      "none",
    );
  });

  it("is plain when stdout is not a TTY", () => {
    expect(resolveColourMode({ isTTY: false, env: {} })).toBe("none");
    expect(resolveColourMode({ isTTY: false, env: { COLORTERM: "truecolor" } })).toBe("none");
  });

  it("picks truecolor when COLORTERM says so, else a 256-colour approximation", () => {
    expect(resolveColourMode({ isTTY: true, env: { COLORTERM: "truecolor" } })).toBe("truecolor");
    expect(resolveColourMode({ isTTY: true, env: { COLORTERM: "24bit" } })).toBe("truecolor");
    expect(resolveColourMode({ isTTY: true, env: {} })).toBe("ansi256");
    expect(resolveColourMode({ isTTY: true, env: { COLORTERM: "" } })).toBe("ansi256");
  });

  it("is plain on a dumb terminal", () => {
    expect(resolveColourMode({ isTTY: true, env: { TERM: "dumb", COLORTERM: "truecolor" } })).toBe(
      "none",
    );
  });

  it("gives a terminal that calls itself plain xterm, screen or the Linux console 16 colours", () => {
    for (const term of ["xterm", "xterm-color", "screen", "tmux", "linux", "vt100", "ansi"])
      expect(resolveColourMode({ isTTY: true, env: { TERM: term } }), term).toBe("ansi16");
  });

  it("gives a terminal that says 256color, or is not on the short list, 256 colours", () => {
    for (const term of [
      "xterm-256color",
      "screen-256color",
      "tmux-256color",
      "alacritty",
      "xterm-kitty",
    ])
      expect(resolveColourMode({ isTTY: true, env: { TERM: term } }), term).toBe("ansi256");
  });

  it("lets COLORTERM and a -direct terminal beat a modest TERM", () => {
    expect(resolveColourMode({ isTTY: true, env: { TERM: "xterm", COLORTERM: "truecolor" } })).toBe(
      "truecolor",
    );
    expect(resolveColourMode({ isTTY: true, env: { TERM: "xterm-direct" } })).toBe("truecolor");
  });
});

describe("resolveFlavour", () => {
  it("passes an explicit flavour through unchanged", () => {
    expect(resolveFlavour("latte", {})).toBe("latte");
    expect(resolveFlavour("frappe", {})).toBe("frappe");
    expect(resolveFlavour("macchiato", {})).toBe("macchiato");
    expect(resolveFlavour("mocha", {})).toBe("mocha");
  });

  it("resolves system to mocha unless COLORFGBG says the background is light", () => {
    expect(systemFlavourFromEnv({})).toBe("mocha");
    expect(systemFlavourFromEnv({ COLORFGBG: "15;0" })).toBe("mocha");
    expect(systemFlavourFromEnv({ COLORFGBG: "0;15" })).toBe("latte");
    expect(systemFlavourFromEnv({ COLORFGBG: "0;7" })).toBe("latte");
    expect(resolveFlavour("system", { COLORFGBG: "0;15" })).toBe("latte");
    expect(resolveFlavour("system", {})).toBe("mocha");
  });
});

describe("createColours", () => {
  it("disables painting under NO_COLOR or without a TTY", () => {
    const noColor = createColours({ theme: "mocha", isTTY: true, env: { NO_COLOR: "1" } });
    expect(noColor.enabled).toBe(false);
    expect(noColor.paint("accent", "hi")).toBe("hi");

    const notTty = createColours({ theme: "mocha", isTTY: false, env: {} });
    expect(notTty.enabled).toBe(false);
    expect(notTty.paint("accent", "hi")).toBe("hi");
  });

  it("maps the accent role to that flavour's accent-text hex, truecolor-encoded", () => {
    // Text is painted with the `-text` variants the desktop app uses for text:
    // the same colour in the dark flavours, the readable one in Latte.
    for (const flavour of ["latte", "frappe", "macchiato", "mocha"] as const) {
      const colours = createColours({
        theme: flavour,
        isTTY: true,
        env: { COLORTERM: "truecolor" },
      });
      const hex = themeDoc.flavours[flavour].roles["accent-text"];
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      expect(colours.paint("accent", "x")).toBe(`\x1b[38;2;${r};${g};${b}mx\x1b[0m`);
    }
  });

  it("falls back to a 256-colour escape when the terminal is not truecolor", () => {
    const colours = createColours({ theme: "mocha", isTTY: true, env: {} });
    const painted = colours.paint("accent", "x");
    expect(painted).toMatch(/^\x1b\[38;5;\d+mx\x1b\[0m$/);
  });

  it("returns the resolved flavour", () => {
    expect(createColours({ theme: "latte", isTTY: true, env: {} }).flavour).toBe("latte");
    expect(createColours({ theme: "system", isTTY: true, env: {} }).flavour).toBe("mocha");
  });
});

const TTY_TRUECOLOR = { isTTY: true, env: { COLORTERM: "truecolor" } };
const TTY_16 = { isTTY: true, env: { TERM: "xterm" } };

/** xterm's own 256-colour palette above the system colours, built independently of the code under test. */
function xtermPalette(): Array<[number, number, number]> {
  const levels = [0, 95, 135, 175, 215, 255];
  const palette: Array<[number, number, number]> = [];
  for (const r of levels) for (const g of levels) for (const b of levels) palette.push([r, g, b]);
  for (let step = 0; step < 24; step++) palette.push([8 + step * 10, 8 + step * 10, 8 + step * 10]);
  return palette;
}

describe("the 256-colour approximation", () => {
  const palette = xtermPalette();
  const nearest = (r: number, g: number, b: number) => {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, [pr, pg, pb]] of palette.entries()) {
      const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return 16 + best;
  };

  it("picks the nearest cell of the cube or the grey ramp for every role of every flavour", () => {
    for (const flavour of Object.values(themeDoc.flavours))
      for (const hex of Object.values(flavour.roles)) {
        const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
        const got = rgbToAnsi256(r, g, b);
        const want = nearest(r, g, b);
        const distance = (index: number) => {
          const [pr, pg, pb] = palette[index - 16];
          return (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        };
        expect(distance(got), hex).toBe(distance(want));
      }
  });

  it("uses the cube's real levels, not evenly spaced ones", () => {
    // 148 is nearer xterm's 135 than 175; an even six-step split would say 153 -> 175.
    expect(rgbToAnsi256(148, 226, 213)).toBe(16 + 36 * 2 + 6 * 4 + 4);
    expect(rgbToAnsi256(95, 135, 175)).toBe(16 + 36 * 1 + 6 * 2 + 3);
  });

  it("sends greys to the grey ramp, and the ends to black and white", () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
    expect(rgbToAnsi256(255, 255, 255)).toBe(231);
    expect(rgbToAnsi256(128, 128, 128)).toBe(232 + 12);
  });
});

describe("the 16-colour fallback", () => {
  const colours = createColours({ theme: "mocha", ...TTY_16 });

  it("gives every meaningful role its own regular ANSI colour", () => {
    const code = (role: Parameters<typeof colours.paint>[0]) =>
      colours.paint(role, "x").split("x")[0];
    const roles = ["accent", "accent2", "ok", "active", "review", "fault"] as const;
    expect(new Set(roles.map(code)).size).toBe(roles.length);
    for (const role of roles) expect(code(role)).toMatch(/^\x1b\[3[0-7]m$/);
  });

  it("dims what should recede, rather than reaching for a bright colour", () => {
    for (const role of ["faint", "line", "ended", "unknown"] as const)
      expect(colours.paint(role, "x")).toBe("\x1b[2mx\x1b[0m");
  });

  it("leaves body text in the terminal's own foreground", () => {
    expect(colours.paint("text", "x")).toBe("x");
    expect(colours.paint("muted", "x")).toBe("x");
  });

  it("never emits an extended colour escape", () => {
    for (const role of ["accent", "ok", "fault", "faint", "text"] as const)
      expect(colours.paint(role, "x")).not.toMatch(/\[38;/);
  });
});

describe("text styles", () => {
  it("wraps text in the style and resets it, when colour is on", () => {
    const colours = createColours({ theme: "mocha", ...TTY_TRUECOLOR });
    expect(colours.style("bold", "x")).toBe("\x1b[1mx\x1b[0m");
    expect(colours.style("underline", "x")).toBe("\x1b[4mx\x1b[0m");
  });

  it("leaves text plain when colour is off", () => {
    expect(PLAIN.style("bold", "x")).toBe("x");
    expect(PLAIN.paint("accent", "x")).toBe("x");
    expect(PLAIN.enabled).toBe(false);
  });

  it("leaves empty text empty, so a blank line stays blank", () => {
    const colours = createColours({ theme: "mocha", ...TTY_TRUECOLOR });
    expect(colours.style("bold", "")).toBe("");
    expect(colours.paint("accent", "")).toBe("");
  });
});

describe("the desktop app's tones as terminal roles", () => {
  it("paints each tone the way the desktop stylesheet does", () => {
    expect(roleForTone("accepted")).toBe("ok");
    expect(roleForTone("active")).toBe("active");
    expect(roleForTone("review")).toBe("review");
    // `.state-label.tone-waiting` shares `tone-review`'s colour.
    expect(roleForTone("waiting")).toBe("review");
    expect(roleForTone("problem")).toBe("fault");
    expect(roleForTone("muted")).toBe("ended");
    expect(roleForTone("something new")).toBe("unknown");
  });
});
