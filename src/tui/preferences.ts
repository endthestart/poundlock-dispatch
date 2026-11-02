/**
 * What this terminal client remembers between sessions on this computer, as
 * the desktop app keeps its own view choices on the Mac. Written only when a
 * choice changes.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptDensity } from "@shared/live-work-view";

export interface TuiPreferences {
  transcriptDensity: TranscriptDensity;
  /** Ring the bell when a project needs you or a run stops building: the app's notifications. */
  bell: boolean;
}

export interface TuiPreferenceStore {
  read(): Promise<TuiPreferences>;
  write(preferences: TuiPreferences): Promise<void>;
}

const DEFAULTS: TuiPreferences = { transcriptDensity: "normal", bell: true };

function parse(text: string): TuiPreferences {
  const saved = JSON.parse(text) as Partial<TuiPreferences>;
  return {
    transcriptDensity: saved.transcriptDensity === "verbose" ? "verbose" : "normal",
    bell: saved.bell !== false,
  };
}

/** Kept in one JSON file; a missing file is the defaults, an unreadable one is an error. */
export function filePreferences(file: string): TuiPreferenceStore {
  return {
    read: async () => {
      const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      return text === undefined ? { ...DEFAULTS } : parse(text);
    },
    write: (preferences) => writeFile(file, `${JSON.stringify(preferences)}\n`, "utf8"),
  };
}

/** For a client with nowhere to keep them: tests, and a screen opened without a data root. */
export function memoryPreferences(initial: TuiPreferences = DEFAULTS): TuiPreferenceStore {
  let current = { ...initial };
  return {
    read: async () => ({ ...current }),
    write: async (preferences) => {
      current = { ...preferences };
    },
  };
}

/** This client's preferences file, shared by the screen and the host's alerts. */
export function tuiPreferencesFile(dataRoot: string): TuiPreferenceStore {
  return filePreferences(join(dataRoot, "tui-preferences.json"));
}
