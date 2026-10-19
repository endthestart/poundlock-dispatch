/**
 * What one command may reach, from what it asked for and the project's two
 * network switches (ADR 015).
 */
import type { NetworkReach } from "../shared/network.js";
import { proxyEnvironment, runningReachProxy } from "./registry-proxy.js";
import type { NetworkMode } from "./run-command.js";
import { networkOnlyProfile } from "./sandbox.js";

export type CommandNetwork =
  /** No network at all. */
  | { kind: "none" }
  /** Both switches on: the network as the user has it. */
  | { kind: "direct" }
  /** A dependency install: package registries only, through the registry proxy (L19). */
  | { kind: "registry" }
  /** One switch on: this Mac, and the reach proxy for the rest. */
  | { kind: "reach" };

/** The network for a command, or why it cannot run. */
export function commandNetwork(
  requested: NetworkMode,
  reach: NetworkReach,
  readOnly = false,
): CommandNetwork | { refused: string } {
  if (readOnly) {
    return requested === "dependency"
      ? { refused: "This is a read-only investigation, so commands have no network." }
      : { kind: "none" };
  }
  if (requested === "deny") return { kind: "none" };
  if (requested === "dependency") {
    return reach.internet
      ? { kind: "registry" }
      : {
          refused:
            "Internet is off for this project, so dependencies cannot be downloaded. Turn Internet on in the project's settings.",
        };
  }
  if (reach.internet && reach.localNetwork) return { kind: "direct" };
  if (reach.internet || reach.localNetwork) return { kind: "reach" };
  return { kind: "none" };
}

interface BashSpawn {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A spawn hook for Pi's raw Bash tool, which runs with the user's authority:
 * it wraps each command in a network-only sandbox that holds the project's
 * switches as they are when the command starts. `enforced` is false where
 * sandbox-exec is unavailable, and the hook then changes nothing.
 */
export function networkBashHook(
  currentReach: () => NetworkReach,
  enforced: boolean,
): (spawn: BashSpawn) => BashSpawn {
  return (spawn) => {
    if (!enforced) return spawn;
    const reach = currentReach();
    const network = commandNetwork("allow", reach);
    if ("refused" in network || network.kind === "direct") return spawn;
    // A reach proxy that is not running fails closed to no network.
    const proxy = network.kind === "reach" ? runningReachProxy(reach) : undefined;
    const profile = networkOnlyProfile(proxy ? "proxy" : "deny", {
      port: proxy?.port,
      loopback: reach.localNetwork,
    });
    return {
      ...spawn,
      env: {
        ...spawn.env,
        ...(proxy ? proxyEnvironment(proxy, reach.localNetwork) : {}),
        DISPATCH_NETWORK_PROFILE: profile,
        DISPATCH_COMMAND: spawn.command,
      },
      command:
        'exec /usr/bin/sandbox-exec -p "$DISPATCH_NETWORK_PROFILE" /bin/bash -c "$DISPATCH_COMMAND"',
    };
  };
}
