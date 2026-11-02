/**
 * What the terminal does where the desktop app shows a notification: rings
 * the bell. A run that stops building or moves to the local fallback also
 * says which, since a bell alone cannot name a project.
 */
import type { DispatchHost, HostFacilities } from "@core/host/dispatch-host";
import type { TuiPreferenceStore } from "./preferences.js";

/** ASCII BEL, written as a code point so it is visible in source. */
const BELL = String.fromCharCode(7);

export function terminalAlerts(
  host: () => Pick<DispatchHost, "setNotice" | "emitState">,
  write: (text: string) => void,
  preferences: TuiPreferenceStore,
): Pick<HostFacilities, "notifyNeedsYou" | "notifyAutopilot"> {
  // Read at each alert, so `/appearance notify` applies at once. An unreadable
  // file rings: the bell is on unless it was turned off.
  const ring = () =>
    void preferences.read().then(
      (saved) => saved.bell && write(BELL),
      () => write(BELL),
    );
  return {
    // Called whenever the count changes; only a rise is something new to decide.
    notifyNeedsYou: (_count, _preferences, alert) => {
      if (alert) ring();
    },
    notifyAutopilot: (project, glance) => {
      ring();
      host().setNotice({ kind: "info", text: `Autopilot · ${glance.label}: ${project}` });
      // Called while the host emits; the notice shows on the next emit, not inside this one.
      setTimeout(() => void host().emitState(), 0);
    },
  };
}
