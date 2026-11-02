/** What the slash-command handlers may use of the running terminal client. */

import type { DispatchHost } from "@core/host/dispatch-host";
import type { TUI } from "@earendil-works/pi-tui";
import type { RoleMap } from "@shared/roles";
import type { AppStateView } from "@shared/types";
import type { Colours } from "./colour.js";
import type { TuiPreferenceStore } from "./preferences.js";

export interface CommandSurface {
  host: DispatchHost;
  tui: TUI;
  colours: Colours;
  preferences: TuiPreferenceStore;
  state(): AppStateView | undefined;
  /** The open project's folder, if it has one on this computer. */
  folder(): string | undefined;
  /** While a hidden prompt is open, keys go to it and not to the shortcuts. */
  setPrompting(on: boolean): void;
  /** Name the work in progress beside the spinner, or clear it. */
  setWorking(label: string | undefined): void;
  /** Roles `/role` chose that wait for the rest of the map before they can be saved. */
  stagedRoles: RoleMap;
}

/** The open project, as a host action names it. */
export function projectTarget(surface: CommandSurface): { projectId: string } | undefined {
  const projectId = surface.state()?.selectedProjectId;
  return projectId ? { projectId } : undefined;
}
