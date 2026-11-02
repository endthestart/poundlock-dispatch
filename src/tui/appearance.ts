/**
 * `/appearance`: Settings → Appearance in the app. The theme, which the app
 * and this client share; whether the bell rings, the terminal's version of
 * the app's notifications; and the chips beside the composer.
 */
import { APPEARANCE_THEMES, type AppearanceTheme } from "@shared/appearance";
import { STATUS_INFOLET_CATALOG } from "@shared/status-infolets";
import type { AppStateView } from "@shared/types";
import type { ComposerInfoletId } from "@shared/ui-preferences";

const CHIPS = STATUS_INFOLET_CATALOG.map((item) => item.id);

const APPEARANCE_USAGE = [
  "Usage: /appearance, or /appearance with one of:",
  `  theme <${APPEARANCE_THEMES.join("|")}>   notify <on|off>`,
  `  chip <${CHIPS.join("|")}> <on|off>`,
].join("\n");

export type AppearanceChange =
  | { action: "show" }
  | { action: "theme"; theme: AppearanceTheme }
  | { action: "notify"; bell: boolean }
  | { action: "chips"; composerInfolets: ComposerInfoletId[] };

export function appearanceLines(state: AppStateView, bell: boolean): string {
  const shown = STATUS_INFOLET_CATALOG.filter((item) =>
    state.ui.composerInfolets.includes(item.id),
  );
  return [
    `Theme: ${state.appearance.theme}, shared with the desktop app.`,
    `Bell when a project needs you or a run stops building: ${bell ? "on" : "off"}.`,
    `Beside the composer: ${shown.length ? shown.map((item) => item.label.toLowerCase()).join(", ") : "nothing"}.`,
  ].join("\n");
}

const onOff = (value: string | undefined): boolean => {
  if (value === "on" || value === "off") return value === "on";
  throw new Error(APPEARANCE_USAGE);
};

export function parseAppearance(args: string, state: AppStateView): AppearanceChange {
  const [action, first, second, ...extra] = args.trim().split(/\s+/).filter(Boolean);
  if (!action) return { action: "show" };
  if (extra.length) throw new Error(APPEARANCE_USAGE);
  if (action === "theme" && !second) {
    const theme = APPEARANCE_THEMES.find((name) => name === first);
    if (!theme) throw new Error(APPEARANCE_USAGE);
    return { action: "theme", theme };
  }
  if (action === "notify" && !second) return { action: "notify", bell: onOff(first) };
  if (action === "chip") {
    const chip = CHIPS.find((id) => id === first);
    if (!chip) throw new Error(APPEARANCE_USAGE);
    const others = state.ui.composerInfolets.filter((id) => id !== chip);
    return {
      action: "chips",
      composerInfolets: onOff(second) ? [...others, chip] : others,
    };
  }
  throw new Error(APPEARANCE_USAGE);
}
