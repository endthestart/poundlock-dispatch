/**
 * `/connect`: set the Poundlock controller address and application token from
 * the terminal, so nobody has to open the desktop app first.
 *
 * It is the desktop wizard's own sequence on the same host: save the address
 * and token, which writes `connection.json` and `connection.secret.json` in
 * the shared config folder, then test it with the host's `testConnection`,
 * which is what the wizard's Test connection button calls. Nothing here
 * writes a file or talks to the controller itself.
 *
 * The token is asked for on its own, hidden, and is never a command argument:
 * an argument would sit in the composer and its history.
 */
import type { DispatchHost } from "@core/host/dispatch-host";
import { EXAMPLE_CONTROLLER_URL } from "@shared/types";

export interface ConnectPrompts {
  /** The controller address; empty keeps `current`. `undefined` means cancelled. */
  address(current: string): Promise<string | undefined>;
  /** The application token, hidden; empty keeps the saved one. `undefined` means cancelled. */
  token(saved: boolean): Promise<string | undefined>;
}

export interface ConnectOutcome {
  kind: "cancelled" | "connected" | "failed";
  /** What to tell the user. Never contains the token. */
  text: string;
}

function sameAddress(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
}

/** A controller address is a full http or https URL. `undefined` when this one is. */
export function controllerAddressError(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.protocol === "http:" || url.protocol === "https:") return undefined;
  } catch {
    // Falls through to the message.
  }
  return `Enter the controller address as a full URL, for example ${EXAMPLE_CONTROLLER_URL}.`;
}

/**
 * Ask for, save and test the connection. Throws for input that cannot be used
 * (a missing or malformed address, no token); a controller that does not
 * answer is an outcome, not an error, because the address and token are saved
 * either way, as they are in the desktop app.
 */
export async function connectController(
  host: DispatchHost,
  prompts: ConnectPrompts,
  address?: string,
  /** Told what is happening while the controller is being tried, and `undefined` when done. */
  progress?: (label: string | undefined) => void,
): Promise<ConnectOutcome> {
  const current = await host.getConnection();
  const typed = address?.trim() || (await prompts.address(current.url))?.trim();
  if (typed === undefined) return { kind: "cancelled", text: "Connection unchanged." };
  const url = typed || current.url;
  if (!url) throw new Error(`Enter the controller address, for example ${EXAMPLE_CONTROLLER_URL}.`);
  const invalid = controllerAddressError(url);
  if (invalid) throw new Error(invalid);

  // A new address starts without the old token: it belongs to another controller.
  const keepsToken = current.tokenConfigured && sameAddress(url, current.url);
  const entered = await prompts.token(keepsToken);
  if (entered === undefined) return { kind: "cancelled", text: "Connection unchanged." };
  const token = entered.trim();
  if (!token && !keepsToken)
    throw new Error("Paste an application token from Poundlock Access, then run /connect again.");

  await host.saveConnection({ url, token, roles: current.roles });
  progress?.("Testing the connection to Poundlock…");
  const tested = await host.testConnection().finally(() => progress?.(undefined));
  const probe = tested.probe;
  if (!probe?.ok) {
    const reason = `${probe?.error ?? "The controller did not respond."}${probe?.hint ? ` ${probe.hint}` : ""}`;
    return {
      kind: "failed",
      text: `Saved the address and token, but the connection test failed. ${reason} Run /connect to try again.`,
    };
  }
  return {
    kind: "connected",
    text: `Connected to Poundlock${probe.version ? ` ${probe.version}` : ""}. ${
      tested.connection.rolesReady
        ? "Models are set; /setup shows them."
        : "Choose models next: /models lists them and /role <role> <profile> binds one."
    }`,
  };
}
