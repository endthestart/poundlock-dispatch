/**
 * The composer as drawn: a box around the editor, its border saying whether
 * it is the thing to type into, and its title saying what Enter will do.
 */

import { CombinedAutocompleteProvider, type Editor, type TUI } from "@earendil-works/pi-tui";
import { projectStatusView } from "@shared/project-status";
import type { AppStateView } from "@shared/types";
import { localFolder } from "./app-state.js";
import { editorTheme } from "./app-views.js";
import { BoxedEditor } from "./boxed-editor.js";
import { fitSentence } from "./chrome.js";
import type { ColourRole, Colours } from "./colour.js";
import { COMMAND_DEFS, toSlashCommands } from "./commands.js";
import { composerHint } from "./render.js";

export class Composer {
  readonly box: BoxedEditor;
  readonly editor: Editor;
  /** Whether the composer is refusing to send, which dims its border. */
  private blocked = false;

  constructor(
    tui: TUI,
    private readonly colours: Colours,
    /** Whether the keys are the composer's rather than a card's. */
    hasKeys: () => boolean,
    footer: (inner: number) => string,
  ) {
    const border = (): ColourRole => (hasKeys() && !this.blocked ? "accent" : "line");
    this.box = new BoxedEditor(tui, editorTheme(colours, border), (text) =>
      colours.paint(border(), text),
    );
    this.box.setFooter(footer);
    this.editor = this.box.editor;
  }

  /** Whether anything is half-typed. */
  drafting(): boolean {
    return Boolean(this.editor.getText().trim());
  }

  /**
   * Up and Down walk back through what you have sent, as Pi does when it
   * resumes a session. "/" completes with a description, and "@" completes a
   * path relative to the project's own folder.
   */
  prepare(state: AppStateView): void {
    for (const message of state.snapshot?.messages ?? [])
      if (message.role === "user") this.editor.addToHistory(message.text);
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        toSlashCommands(COMMAND_DEFS),
        localFolder(state) ?? process.cwd(),
      ),
    );
  }

  /** What the composer will do, or why it will not, set into its border. */
  showHint(state: AppStateView): void {
    const snapshot = state.snapshot;
    const status = snapshot
      ? projectStatusView(snapshot, { approvals: state.approvals })
      : undefined;
    const hint = composerHint(state, status);
    this.blocked = hint.blocked;
    this.box.setTitle((room) =>
      this.colours.paint(hint.blocked ? "review" : "muted", fitSentence(hint.text, room)),
    );
  }
}
