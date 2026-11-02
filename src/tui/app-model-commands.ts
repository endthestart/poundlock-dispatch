/** The connection and model commands: `/connect`, `/approve-models`, `/models` and `/role`. */

import { type SelectItem } from "@earendil-works/pi-tui";
import type { ExecutionRole, RoleBinding, RoleMap } from "@shared/roles";
import {
  bindingForProfile,
  catalogFromProbe,
  destinationLabel,
  EXECUTION_ROLES,
  guessRoleMap,
  roleMapReady,
  roleUnavailableReason,
} from "@shared/roles";
import { EXAMPLE_CONTROLLER_URL } from "@shared/types";
import type { CommandSurface } from "./app-command-surface.js";
import { proseColumn } from "./app-views.js";
import { connectController } from "./connect.js";
import {
  DESTINATION_USAGE,
  destinationOverride,
  modelDetailLines,
  modelListRows,
  roleName,
} from "./model-detail.js";
import { showPicker } from "./picker.js";
import { matchProfile } from "./project-model.js";
import { showPrompt } from "./prompt.js";

/** The roles as `/role` and the app name them. */
const ROLE_NAMES = EXECUTION_ROLES.map(roleName);

/**
 * Set the controller address and token, as the desktop app's setup does. The
 * token is asked for hidden and is never a command argument, where it would
 * sit in the composer's history.
 */
export async function connect(app: CommandSurface, input: string): Promise<void> {
  const args = input.trim().split(/\s+/).slice(1);
  if (args.length > 1)
    throw new Error(
      "Usage: /connect [address]. The token is asked for next, hidden: do not type it here.",
    );
  app.setPrompting(true);
  let outcome: Awaited<ReturnType<typeof connectController>> | undefined;
  try {
    outcome = await connectController(
      app.host,
      {
        address: (current) =>
          showPrompt(app.tui, app.colours, {
            title: "Poundlock controller address",
            step: "1 of 2",
            detail: [
              `For example ${EXAMPLE_CONTROLLER_URL}. A remote HTTPS controller also works.`,
              ...(current ? ["Enter keeps the saved address."] : []),
            ],
            initial: current,
          }),
        token: (saved) =>
          showPrompt(app.tui, app.colours, {
            title: "Application token",
            step: "2 of 2",
            detail: [
              "One application token from Poundlock Access. Stored only on this computer, never shown, and never included in prompts or worker jobs.",
              ...(saved ? ["Enter keeps the saved token."] : []),
            ],
            secret: true,
          }),
      },
      args[0],
      // The test can take seconds; without a word, the screen looked hung.
      (label) => app.setWorking(label),
    );
    app.host.setNotice({
      kind: outcome.kind === "failed" ? "error" : "info",
      text: outcome.text,
    });
    await app.host.emitState();
  } finally {
    app.setPrompting(false);
    app.setWorking(undefined);
  }
  if (outcome?.kind === "connected") await chooseMissingModels(app);
}

/**
 * The app's setup, step 2: once connected, choose the Manager and the Worker
 * that are not set yet, in the same pickers `/role <role>` opens.
 */
async function chooseMissingModels(app: CommandSurface): Promise<void> {
  const missing = async (role: "manager" | "interactive") =>
    !(
      (await app.host.getState()).connection.roles?.[role]?.profileId ||
      app.stagedRoles[role]?.profileId
    );
  for (const role of ["manager", "interactive"] as const) {
    if (!(await missing(role))) continue;
    await setRole(app, `/role ${role}`);
    // Escape leaves the rest to /role, as closing the app's setup does.
    if (await missing(role)) return;
  }
}

/**
 * Re-confirm where each role's model runs, after Poundlock changes the route
 * behind a profile. This is a consent decision, so it names the destinations
 * being approved rather than approving them silently — the same thing saving
 * the model map does in the desktop app.
 */
export async function approveModels(app: CommandSurface): Promise<void> {
  // Approval is against the route Poundlock advertises right now, so the
  // catalog has to be fresh — approving against a stale one would record a
  // revision the controller no longer serves.
  await app.host.refreshServerInfo();
  const roles = (await app.host.getState()).connection.roles ?? {};
  const destinations = Object.entries(roles)
    .filter((entry): entry is [string, RoleBinding] => Boolean(entry[1]))
    .map(([role, binding]) => ({
      role,
      text: `${role}: ${binding.profileName ?? binding.profileId} → ${binding.approvedDataDestination ?? "unknown"}`,
    }));
  if (!destinations.length)
    throw new Error("No models are mapped yet. Set them in the desktop app.");
  // A route change is a consent decision, so it is named — every
  // destination it would send context to — rather than approved silently
  // on the strength of one command.
  const items: SelectItem[] = [
    {
      value: "approve",
      label: "Approve this route",
      description: destinations.map((entry) => entry.text).join("; "),
    },
    { value: "cancel", label: "Cancel" },
  ];
  const picked = await showPicker(app.tui, app.colours, items, {
    title: "Approve the route Poundlock is serving now",
  });
  if (!picked || picked.value === "cancel") return;
  await app.host.saveModels(roles);
  app.host.setNotice({
    kind: "info",
    text: `Approved the current route for ${destinations.map((entry) => entry.text).join(", ")}.`,
  });
  await app.host.emitState();
}

/**
 * The catalog Poundlock is serving right now, and what each role is bound
 * to. Without this a terminal-only user could not see the profile names
 * `/role` takes, let alone choose between them.
 */
export async function listModels(app: CommandSurface, input: string): Promise<void> {
  await app.host.refreshServerInfo();
  const state = await app.host.getState();
  if (!state.probe?.ok)
    throw new Error(`Poundlock is not reachable: ${state.probe?.error ?? "unknown"}`);
  const catalog = catalogFromProbe({ interactiveModels: state.probe.interactiveModels ?? [] });
  if (!catalog.length) throw new Error("Poundlock is serving no model profiles.");
  const wanted = input.trim().slice("/models".length).trim();
  if (wanted) {
    // `<profile> destination <own|external|reported>`: Models and routing's override.
    const override = /^(.+?)\s+destination(?:\s+(\S+))?$/.exec(wanted);
    const profile = matchProfile(catalog, override?.[1] ?? wanted);
    const id = profile.profileId ?? profile.id;
    if (override) {
      if (!override[2]) throw new Error(DESTINATION_USAGE);
      const saved = await app.host.saveProfile(id, {
        ...state.connection.profiles?.[id],
        approvedDestination: destinationOverride(override[2]),
      });
      state.connection = saved.connection;
    }
    app.host.setNotice({
      kind: "info",
      text: modelDetailLines(profile, state.connection.profiles?.[id]?.approvedDestination).join(
        "\n",
      ),
    });
    await app.host.emitState();
    return;
  }
  const lines = [
    "Model profiles Poundlock is serving:",
    ...modelListRows(
      catalog,
      state.connection.roles ?? {},
      proseColumn(process.stdout.columns || 80) - 2,
    ),
    "",
    `Roles: ${ROLE_NAMES.join(", ")}. Bind one with /role <role> <profile>.`,
    "Changing a role ends the current manager session and needs /approve-models.",
    "/models <profile> says more about one.",
  ];
  app.host.setNotice({ kind: "info", text: lines.join("\n") });
  await app.host.emitState();
}

/**
 * Bind one role to one profile — the terminal equivalent of the desktop
 * app's model picker. Until this existed a terminal-only user had to
 * install the desktop app to choose which model manages their work.
 */
export async function setRole(app: CommandSurface, input: string): Promise<void> {
  const [, typed, ...rest] = input.trim().split(/\s+/);
  const wanted = rest.join(" ");
  if (!typed) throw new Error(`Name a role: /role <${ROLE_NAMES.join("|")}> [profile]`);
  const role = typed === "worker" ? "interactive" : typed;
  if (!(EXECUTION_ROLES as readonly string[]).includes(role))
    throw new Error(`Unknown role ${typed}. One of: ${ROLE_NAMES.join(", ")}`);
  const name = roleName(role as ExecutionRole);

  // Bind against the catalog Poundlock is serving now, not a remembered
  // one: a name that no longer resolves is worse than a refusal.
  await app.host.refreshServerInfo();
  const state = await app.host.getState();
  if (!state.probe?.ok)
    throw new Error(`Poundlock is not reachable: ${state.probe?.error ?? "unknown"}`);
  const catalog = catalogFromProbe({ interactiveModels: state.probe.interactiveModels ?? [] });

  if (!wanted) {
    // No profile named: offer every profile Poundlock serves, destination
    // and all — an unavailable one is still shown (silence would look like
    // the terminal missed it), but picking it below refuses exactly as
    // typing its name would.
    if (!catalog.length) throw new Error("Poundlock is serving no model profiles.");
    const items: SelectItem[] = catalog.map((profile) => {
      const reason = roleUnavailableReason(profile, role as ExecutionRole);
      const destination = destinationLabel(profile.dataDestination);
      return {
        value: profile.profileId ?? profile.id,
        label: profile.name,
        description: reason ? `${destination} — unavailable: ${reason}` : destination,
      };
    });
    // Highlighted: the current binding, else the app's setup suggestion.
    const suggested = {
      ...guessRoleMap(state.probe),
      ...state.connection.roles,
      ...app.stagedRoles,
    }[role as ExecutionRole];
    const picked = await showPicker(app.tui, app.colours, items, {
      title: `Model for the ${name} role`,
      initial: suggested?.profileId,
    });
    if (picked) await setRole(app, `/role ${role} ${picked.value}`);
    return;
  }

  const chosen = matchProfile(catalog, wanted);
  // The same check the desktop picker applies. Without it the terminal
  // saved a binding the first turn would then refuse — a blocked
  // destination, an autocomplete model as manager — with the error arriving
  // minutes later instead of here.
  const unavailable = roleUnavailableReason(chosen, role as ExecutionRole);
  if (unavailable) throw new Error(`${chosen.name} cannot serve ${name}: ${unavailable}.`);

  // The same binding the desktop app's picker saves.
  const binding = bindingForProfile(chosen);
  const roles: RoleMap = {
    ...(state.connection.roles ?? {}),
    ...app.stagedRoles,
    [role]: binding,
  };
  const runsOn = `${name} runs on ${chosen.name} (${destinationLabel(chosen.dataDestination)})`;
  // The host saves a model map only once it has a manager and a worker, as
  // the app's setup does; the first of the two waits here for the other.
  if (!roleMapReady(roles)) {
    app.stagedRoles[role as ExecutionRole] = binding;
    const next = roles.manager?.profileId ? "worker" : "manager";
    app.host.setNotice({
      kind: "info",
      text: `The ${runsOn} once the ${next} is chosen too: /role ${next} <profile>. Nothing is saved until both are set.`,
    });
    await app.host.emitState();
    return;
  }
  await app.host.saveModels(roles);
  for (const staged of Object.keys(app.stagedRoles))
    delete app.stagedRoles[staged as ExecutionRole];
  app.host.setNotice({
    kind: "info",
    text: `The ${runsOn}. The manager session was reset.`,
  });
  await app.host.emitState();
}
