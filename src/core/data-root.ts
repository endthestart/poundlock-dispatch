/**
 * One data root for every Dispatch client (ADR 016). Since 0.3.0 the terminal
 * keeps its projects in the desktop app's root; its own old root holds only
 * Autopilot's runs.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the terminal kept its projects before 0.3.0, and still keeps auto-mode runs. */
function terminalLegacyRoot(): string {
  return join(homedir(), ".poundlock-dispatch");
}

/**
 * Where Autopilot's runs live, for every front end and the runner: the
 * terminal's old root, which is all the confined VM mounts (its `auto` folder).
 */
export function autoBaseRoot(): string {
  return process.env.POUNDLOCK_DISPATCH_DATA_DIR || terminalLegacyRoot();
}

/** The Docker context Autopilot's runs use when set; otherwise colima's `dispatch-auto`. */
export function autoDockerContext(): string | undefined {
  return process.env.POUNDLOCK_DISPATCH_DOCKER_CONTEXT || undefined;
}
