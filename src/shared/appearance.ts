/**
 * The one theme choice shared by every Dispatch client on this machine — the
 * desktop GUI and the TUI both read `appearance.json` from the shared config
 * root (see `defaultConfigRoot()` in `@core/paths`) so picking a flavour in
 * one place changes both.
 *
 * This module has no Node or Electron dependency so the TUI can import it
 * directly alongside the GUI (see `tests/source-layering.test.ts`).
 */
export const APPEARANCE_THEMES = ["system", "latte", "frappe", "macchiato", "mocha"] as const;

export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

export interface AppearanceSettings {
  theme: AppearanceTheme;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { theme: "system" };

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return typeof value === "string" && (APPEARANCE_THEMES as readonly string[]).includes(value);
}

/** Unknown or malformed input normalises to "system" rather than throwing. */
export function normalizeAppearance(raw?: Partial<AppearanceSettings> | null): AppearanceSettings {
  return { theme: isAppearanceTheme(raw?.theme) ? raw.theme : "system" };
}
