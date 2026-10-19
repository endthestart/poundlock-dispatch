const COMPOSER_INFOLET_IDS = ["budget", "context"] as const;

/**
 * The version of the saved preferences file, raised whenever a chip is added.
 * A file without one was saved before versions existed.
 */
export const UI_PREFERENCES_VERSION = 2;

/**
 * The file version in which each chip first existed. A chip is newer than a
 * saved file when this is above the file's version, and then it is on by
 * default: the owner has never been offered it, so had no chance to turn it off.
 */
const INFOLET_SINCE: Record<(typeof COMPOSER_INFOLET_IDS)[number], number> = {
  budget: 1,
  context: 2,
};

export type ComposerInfoletId = (typeof COMPOSER_INFOLET_IDS)[number];

export interface UiPreferences {
  composerInfolets: ComposerInfoletId[];
  desktopNotifications: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  composerInfolets: ["budget", "context"],
  desktopNotifications: false,
};

function isComposerInfoletId(value: string): value is ComposerInfoletId {
  return (COMPOSER_INFOLET_IDS as readonly string[]).includes(value);
}

export function normalizeUiPreferences(raw?: Partial<UiPreferences> | null): UiPreferences {
  const requested = raw?.composerInfolets;
  const composerInfolets = Array.isArray(requested)
    ? requested.filter(
        (id): id is ComposerInfoletId => typeof id === "string" && isComposerInfoletId(id),
      )
    : [...DEFAULT_UI_PREFERENCES.composerInfolets];
  return {
    composerInfolets,
    desktopNotifications: Boolean(raw?.desktopNotifications),
  };
}

/** What is written to disk: the preferences and the version they were saved at. */
export interface SavedUiPreferences extends UiPreferences {
  version: number;
}

/** The preferences as they are written, stamped so the next read knows which chips they have seen. */
export function savedUiPreferences(preferences: UiPreferences): SavedUiPreferences {
  return { ...normalizeUiPreferences(preferences), version: UI_PREFERENCES_VERSION };
}

/**
 * The preferences in a saved file. Chips introduced after the file was saved
 * are added, because nobody has yet chosen whether to see them; a chip the
 * owner turned off in a file that already knew it stays off.
 */
export function readSavedUiPreferences(file: unknown): UiPreferences {
  const saved = file && typeof file === "object" ? (file as Partial<SavedUiPreferences>) : null;
  const preferences = normalizeUiPreferences(saved);
  if (!saved) return preferences;
  const version = typeof saved.version === "number" ? saved.version : 1;
  const introduced = COMPOSER_INFOLET_IDS.filter((id) => INFOLET_SINCE[id] > version);
  return {
    ...preferences,
    composerInfolets: [...new Set([...preferences.composerInfolets, ...introduced])],
  };
}
