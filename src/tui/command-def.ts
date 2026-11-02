/**
 * The shape of a command entry, and the one completion every command list
 * uses, so `commands.ts` and `settings-commands.ts` share them without
 * importing each other.
 */
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** A command entry, before `app.ts` attaches its handler. */
export interface CommandDef {
  /** Including the leading "/", so it matches `input.split(/\s+/)[0]` directly. */
  name: `/${string}`;
  description: string;
  argumentHint?: string;
  /**
   * `argumentText` is everything after the command name and one space — the
   * whole remainder, not just the word under the cursor (that is how pi-tui's
   * `CombinedAutocompleteProvider` calls it). A command with more than one
   * argument has to notice for itself which one is being typed.
   */
  getArgumentCompletions?: (argumentText: string) => AutocompleteItem[] | null;
}

export function firstWordCompletions(
  argumentText: string,
  choices: readonly string[],
): AutocompleteItem[] | null {
  // Only the first argument is completed from a fixed list; a second word
  // means the user has moved on to something this file cannot guess (a
  // profile name, a path) without a network call or a directory read.
  if (argumentText.includes(" ")) return null;
  const matches = choices.filter((choice) => choice.startsWith(argumentText));
  // A word typed in full needs no menu: one left open makes Enter accept it instead of sending.
  if (matches.length === 1 && matches[0] === argumentText) return null;
  return matches.length ? matches.map((choice) => ({ value: choice, label: choice })) : null;
}
