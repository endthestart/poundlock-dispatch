/**
 * ANSI colour for the terminal client, mapped from the same Catppuccin roles
 * the desktop app uses (`@shared/theme.json`, vendored from Poundlock — see
 * scripts/sync-theme.sh).
 *
 * `render.ts` builds its lines through `Colours.paint`, so a disabled
 * `Colours` (no TTY, NO_COLOR) yields exactly the plain text the tests and
 * `--json`-style output want, and an enabled one yields the same text with
 * escape codes around it. Everything here is a pure function of its
 * arguments — no reading `process.env` inside the colour functions
 * themselves — so `tests/tui-theme.test.ts` can drive every branch without
 * touching the real environment.
 *
 * Three depths, because a terminal cannot be asked which it has:
 *  - truecolor: the flavour's hex, exactly as the desktop app paints it;
 *  - 256 colours: the nearest cell of xterm's cube or grey ramp, measured
 *    against the real cube levels rather than an evenly spaced guess;
 *  - 16 colours: one ANSI colour per role, chosen by what the role means.
 *    The sixteen are whatever the user's palette says they are, so nothing
 *    here tries to look like Catppuccin, only to keep every role apart and
 *    readable on a dark or a light background.
 */
import { readFileSync } from "node:fs";
import { configLayoutFor, defaultConfigRoot } from "@core/paths";
import { type AppearanceTheme, normalizeAppearance } from "@shared/appearance";
import themeDoc from "@shared/theme.json";

type Flavour = "latte" | "frappe" | "macchiato" | "mocha";
export type ColourMode = "none" | "ansi16" | "ansi256" | "truecolor";

const FLAVOURS = themeDoc.flavours as Record<Flavour, { roles: Record<string, string> }>;

/** The roles the terminal client paints with. */
export type ColourRole =
  | "accent"
  // A second accent, distinct from the first, for markdown links and inline
  // code — so a heading and a link inside it are not the same colour.
  | "accent2"
  // Rules and borders that carry no meaning of their own.
  | "line"
  | "faint"
  | "muted"
  // The theme's own body-text colour, for markdown prose painted explicitly
  // (a code block's fallback colouring) rather than left at the terminal's
  // default foreground.
  | "text"
  | "ok"
  | "active"
  | "review"
  | "fault"
  | "ended"
  | "unknown";

/**
 * Every role paints text, so each one uses the `-text` variant the desktop app
 * uses for text where the theme has one. In the dark flavours the two are the
 * same colour; in Latte the text variants are the ones dark enough to read on
 * a light background.
 */
const ROLE_KEY: Record<ColourRole, string> = {
  accent: "accent-text",
  accent2: "accent-2-text",
  line: "line",
  faint: "faint",
  muted: "muted",
  text: "text",
  ok: "state-ok-text",
  active: "state-active-text",
  review: "state-review-text",
  fault: "state-fault-text",
  ended: "state-ended-text",
  unknown: "state-unknown-text",
};

/**
 * The 16-colour fallback: an SGR parameter per role. Only the eight regular
 * colours (30-37) and the dim attribute: the bright row (90-97) is a grey ramp
 * in several popular palettes, and bold is drawn as bright in others, so
 * neither is dependable. Roles with no entry keep the terminal's own
 * foreground.
 */
const ROLE_ANSI16: Partial<Record<ColourRole, string>> = {
  accent: "36",
  accent2: "35",
  line: "2",
  faint: "2",
  ok: "32",
  active: "34",
  review: "33",
  fault: "31",
  ended: "2",
  unknown: "2",
};

/**
 * The GUI's tones for a task or a project, as the role each is painted in:
 * the same mapping the desktop app's stylesheet makes (`.state-label.tone-*`,
 * `.state-pill.*`).
 */
const TONE_ROLE: Record<string, ColourRole> = {
  accepted: "ok",
  verified: "ok",
  active: "active",
  review: "review",
  waiting: "review",
  problem: "fault",
  queued: "muted",
  muted: "ended",
};

export function roleForTone(tone: string): ColourRole {
  return TONE_ROLE[tone] ?? "unknown";
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/** xterm's colour cube uses these six levels, not evenly spaced ones. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function nearestCubeIndex(channel: number): number {
  let best = 0;
  for (let index = 1; index < CUBE_LEVELS.length; index++)
    if (Math.abs(CUBE_LEVELS[index] - channel) < Math.abs(CUBE_LEVELS[best] - channel))
      best = index;
  return best;
}

/**
 * The nearest of xterm's 240 non-system colours: the 6x6x6 cube and the 24-step
 * grey ramp, whichever is closer to the wanted colour. Soft pastels fall
 * between cube levels, so the grey ramp is what keeps a muted grey from
 * turning slightly lilac.
 */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  const ri = nearestCubeIndex(r);
  const gi = nearestCubeIndex(g);
  const bi = nearestCubeIndex(b);
  const distance = (cr: number, cg: number, cb: number) =>
    (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDistance = distance(CUBE_LEVELS[ri], CUBE_LEVELS[gi], CUBE_LEVELS[bi]);
  const mean = (r + g + b) / 3;
  const step = Math.max(0, Math.min(23, Math.round((mean - 8) / 10)));
  const grey = 8 + step * 10;
  return distance(grey, grey, grey) < cubeDistance ? 232 + step : cube;
}

/** Resolves "system" the same way the terminal already infers a light background. */
export function systemFlavourFromEnv(env: NodeJS.ProcessEnv): "mocha" | "latte" {
  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bg = Number.parseInt(parts.at(-1) ?? "", 10);
    if (bg === 7 || bg === 15) return "latte";
  }
  return "mocha";
}

export function resolveFlavour(theme: AppearanceTheme, env: NodeJS.ProcessEnv): Flavour {
  return theme === "system" ? systemFlavourFromEnv(env) : theme;
}

/**
 * Terminals that name themselves as having fewer than 256 colours. Anything
 * not on this list is taken to have at least 256: nearly every terminal
 * written this century does, and it says so with a TERM this list would have
 * to guess at (`alacritty`, `xterm-kitty`, `wezterm`, `foot`).
 */
const SIXTEEN_COLOUR_TERMS =
  /^(linux|ansi|cygwin|vt\d+|xterm|xterm-color|xterm-16color|rxvt|dtterm|screen|tmux)$/;

/**
 * NO_COLOR, `TERM=dumb` and "not a TTY" all win outright; otherwise truecolor
 * beats a 256-colour guess, and a terminal that names itself as a plain
 * `xterm`, `screen` or the Linux console gets the 16 it can be trusted with.
 * With no TERM at all the answer stays 256, as it always has.
 */
export function resolveColourMode(options: { isTTY: boolean; env: NodeJS.ProcessEnv }): ColourMode {
  if (options.env.NO_COLOR !== undefined) return "none";
  if (!options.isTTY) return "none";
  const term = options.env.TERM ?? "";
  if (term === "dumb") return "none";
  const colorterm = options.env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (term.endsWith("-direct")) return "truecolor";
  if (term.includes("256color")) return "ansi256";
  if (SIXTEEN_COLOUR_TERMS.test(term)) return "ansi16";
  return "ansi256";
}

/** The saved theme, read once at startup — the same file the desktop app writes to. */
function readSavedTheme(configRoot: string = defaultConfigRoot()): AppearanceTheme {
  try {
    const raw = readFileSync(configLayoutFor(configRoot).appearance, "utf8");
    return normalizeAppearance(JSON.parse(raw)).theme;
  } catch {
    return "system";
  }
}

/** The text styles `paint` does not carry: it is colour-only. */
export type TextStyle = "bold" | "italic" | "underline" | "strike" | "inverse";

const STYLE_CODE: Record<TextStyle, string> = {
  bold: "1",
  italic: "3",
  underline: "4",
  strike: "9",
  inverse: "7",
};

export interface Colours {
  readonly enabled: boolean;
  readonly mode: ColourMode;
  readonly flavour: Flavour;
  paint(role: ColourRole, text: string): string;
  /** Bold, italic and the like. Plain when colour is off, so a screen stays readable as text. */
  style(style: TextStyle, text: string): string;
}

const RESET = "\x1b[0m";

function ansiFor(role: ColourRole, hex: string, mode: ColourMode): string | undefined {
  if (mode === "none") return undefined;
  if (mode === "ansi16") {
    const code = ROLE_ANSI16[role];
    return code ? `\x1b[${code}m` : undefined;
  }
  const [r, g, b] = hexToRgb(hex);
  return mode === "truecolor" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbToAnsi256(r, g, b)}m`;
}

/**
 * Builds the paint function for one flavour and terminal capability. Pure:
 * everything it needs is passed in, so tests exercise it without touching
 * `process.env` or a real TTY.
 */
export function createColours(options: {
  theme: AppearanceTheme;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}): Colours {
  const flavour = resolveFlavour(options.theme, options.env);
  const mode = resolveColourMode(options);
  const roles = FLAVOURS[flavour].roles;
  return {
    enabled: mode !== "none",
    mode,
    flavour,
    paint(role, text) {
      if (!text) return text;
      const code = ansiFor(role, roles[ROLE_KEY[role]], mode);
      return code ? `${code}${text}${RESET}` : text;
    },
    style(style, text) {
      return mode !== "none" && text ? `\x1b[${STYLE_CODE[style]}m${text}${RESET}` : text;
    },
  };
}

/** What `app.ts` actually calls at startup: the real environment, the saved theme. */
export function resolveColours(env: NodeJS.ProcessEnv = process.env): Colours {
  return createColours({
    theme: readSavedTheme(),
    isTTY: Boolean(process.stdout.isTTY),
    env,
  });
}

/** Colour off: what a renderer is given when the caller wants plain text. */
export const PLAIN: Colours = createColours({ theme: "mocha", isTTY: false, env: {} });
