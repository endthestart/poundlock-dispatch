/** Project settings by command: checks, models, fix rounds, runtime, repository, web search, grants, worker permissions and network. */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { type SelectItem } from "@earendil-works/pi-tui";
import { describeReach, projectReach } from "@shared/network";
import {
  effectiveToolTrust,
  TOOL_TRUST_MODES,
  type ToolTrustMode,
  toolTrustLabel,
} from "@shared/permissions";
import { catalogFromProbe } from "@shared/roles";
import type { CommandSurface } from "./app-command-surface.js";
import { checksCommand } from "./checks.js";
import { NETWORK_CHOICES } from "./commands.js";
import { fixRoundsCommand } from "./fix-rounds.js";
import { showPicker } from "./picker.js";
import {
  repoAccountChoice,
  repoAccountLine,
  runtimeChoice,
  runtimeLines,
} from "./project-access.js";
import { projectModelCommand } from "./project-model.js";
import { WEB_SEARCH_USAGE, webSearchCommand } from "./web-search.js";

/** A project command's argument, with the open project and the state it was read from. */
export async function projectCommand(app: CommandSurface, input: string) {
  const [, wanted] = input.trim().split(/\s+/);
  const id = requireProject(app);
  const state = await app.host.getState();
  const project = state.projects.find((item) => item.id === id);
  if (!project) throw new Error("Open a project first.");
  return { wanted, id, state, project };
}

export function requireProject(app: CommandSurface): string {
  const id = app.state()?.selectedProjectId;
  if (!id) throw new Error("Open a project first.");
  return id;
}

/**
 * `/grant-file` and `/revoke-file`: Project settings' read exceptions. A
 * relative path is in the project's folder; the host grants the real file a
 * link points at, so taking one back matches on that too.
 */
export async function readGrant(
  app: CommandSurface,
  input: string,
  change: "grant" | "revoke",
): Promise<void> {
  const id = requireProject(app);
  const typed = input.trim().replace(/^\S+\s*/, "");
  if (!typed) throw new Error(`Usage: /${change}-file <path>`);
  const path = resolve(app.folder() ?? process.cwd(), typed);
  if (change === "grant") {
    await app.host.grantReadFile(id, path);
    app.host.setNotice({ kind: "info", text: `The manager may now read ${path}.` });
  } else {
    const project = (await app.host.getState()).projects.find((item) => item.id === id);
    const real = await realpath(path).catch(() => path);
    const grants = project?.policy.readGrants ?? [];
    if (!project || !grants.includes(real)) throw new Error(`${path} is not a read exception.`);
    await app.host.updateProjectPolicy(id, {
      ...project.policy,
      readGrants: grants.filter((grant) => grant !== real),
    });
    app.host.setNotice({ kind: "info", text: `The manager may no longer read ${real}.` });
  }
  await app.host.emitState();
}

/** `/checks`: list, add, remove or clear the project's verification commands. */
export async function checks(app: CommandSurface, input: string): Promise<void> {
  const id = requireProject(app);
  const project = (await app.host.getState()).projects.find((item) => item.id === id);
  if (!project) throw new Error("Open a project first.");
  const result = checksCommand(project.policy, input.trim().slice("/checks".length));
  if (result.policy) await app.host.updateProjectPolicy(id, result.policy);
  app.host.setNotice({ kind: "info", text: result.notice });
  await app.host.emitState();
}

/** `/project-model [manager|worker] [profile|default]`, bound against what Poundlock serves now. */
export async function projectModel(app: CommandSurface, input: string): Promise<void> {
  const id = requireProject(app);
  const args = input.trim().slice("/project-model".length);
  // Naming a profile binds against the catalog Poundlock serves now, as /role does.
  const [, profile] = args.trim().split(/\s+/);
  const naming = Boolean(profile) && profile !== "default";
  if (naming) await app.host.refreshServerInfo();
  const state = await app.host.getState();
  const project = state.projects.find((item) => item.id === id);
  if (!project) throw new Error("Open a project first.");
  if (naming && !state.probe?.ok)
    throw new Error(`Poundlock is not reachable: ${state.probe?.error ?? "unknown"}`);
  const catalog = catalogFromProbe({ interactiveModels: state.probe?.interactiveModels ?? [] });
  const result = projectModelCommand(project.policy, args, catalog);
  if (result.policy) await app.host.updateProjectPolicy(id, result.policy);
  app.host.setNotice({ kind: "info", text: result.notice });
  await app.host.emitState();
}

/** `/fix-rounds [n|default]`: how often a failing task goes back to its worker. */
export async function fixRounds(app: CommandSurface, input: string): Promise<void> {
  const { wanted, id, state, project } = await projectCommand(app, input);
  const result = fixRoundsCommand(project.policy, wanted, state.permissions.fixRoundsPerTask);
  if (result.policy) await app.host.updateProjectPolicy(id, result.policy);
  app.host.setNotice({ kind: "info", text: result.notice });
  await app.host.emitState();
}

/** `/runtime [node <number|folder|none>]`: Project settings → Node runtime. */
export async function runtime(app: CommandSurface, input: string): Promise<void> {
  const { id, project } = await projectCommand(app, input);
  const args = input.trim().replace(/^\S+/, "");
  const candidates = await app.host.runtimeCandidates();
  if (!args.trim()) {
    app.host.setNotice({ kind: "info", text: runtimeLines(project, candidates) });
  } else {
    await app.host.setProjectRuntime(id, "node", runtimeChoice(args, candidates));
  }
  await app.host.emitState();
}

/** `/repo-account [github|gitea|none]`: Project settings → repository access. */
export async function repoAccount(app: CommandSurface, input: string): Promise<void> {
  const { wanted, id, project } = await projectCommand(app, input);
  if (!wanted) app.host.setNotice({ kind: "info", text: repoAccountLine(project) });
  else await app.host.attachForge(id, repoAccountChoice(wanted));
  await app.host.emitState();
}

/** `/websearch [on|off]`: whether this project's manager and Planner may search the web. */
export async function webSearch(app: CommandSurface, input: string): Promise<void> {
  const { wanted, id, state, project } = await projectCommand(app, input);
  if (wanted === "engine") {
    // Settings → Connection → Web search: one SearXNG for every project, or none.
    const [, , url, ...extra] = input.trim().split(/\s+/);
    if (!url || extra.length) throw new Error(WEB_SEARCH_USAGE);
    await app.host.saveWebSearch(url === "none" ? null : url);
    await app.host.emitState();
    return;
  }
  const result = webSearchCommand(project.policy, wanted, state.connection.webSearch?.url);
  if (result.policy) await app.host.updateProjectPolicy(id, result.policy);
  app.host.setNotice({ kind: "info", text: result.notice });
  await app.host.emitState();
}

/**
 * Let this project use another folder. Write access is spelled out rather
 * than assumed, because a granted folder is somebody else's repository.
 */
export async function grant(app: CommandSurface, input: string): Promise<void> {
  const [, path, mode = "read"] = input.split(/\s+/);
  if (!path) throw new Error("Usage: /grant <path> [read|write]");
  if (mode !== "read" && mode !== "write") throw new Error("Grant a folder as read or write.");
  await app.host.grantRoot(requireProject(app), path, mode);
}

/**
 * How this project's worker actions are approved: the terminal's version of
 * the desktop app's permissions chip. With no argument, shows the modes;
 * `default` goes back to the machine-wide setting.
 */
export async function trust(app: CommandSurface, input: string): Promise<void> {
  const { wanted, id, state, project } = await projectCommand(app, input);
  const describe = (override: ToolTrustMode | undefined) =>
    `${toolTrustLabel(effectiveToolTrust(override, state.permissions))} (${
      override ? "this project" : "machine default"
    })`;
  if (!wanted) {
    const items: SelectItem[] = [
      ...TOOL_TRUST_MODES.map((mode) => ({
        value: mode.id,
        label: mode.label,
        description: mode.hint,
      })),
      { value: "default", label: "Machine default", description: describe(undefined) },
    ];
    const picked = await showPicker(app.tui, app.colours, items, {
      title: "Worker permissions for this project",
    });
    if (picked) await trust(app, `/trust ${picked.value}`);
    return;
  }
  const modes = TOOL_TRUST_MODES.map((mode) => mode.id);
  const choice = modes.find((mode) => mode === wanted);
  if (wanted !== "default" && !choice)
    throw new Error(`Unknown mode ${wanted}. One of: ${modes.join(", ")}, default.`);
  await app.host.updateProjectPolicy(id, { ...project.policy, toolTrust: choice });
  app.host.setNotice({ kind: "info", text: `Worker permissions: ${describe(choice)}.` });
  await app.host.emitState();
}

/**
 * The project's Internet and Local network switches (ADR 015). With no
 * argument, shows the four settings with the current one named.
 */
export async function network(app: CommandSurface, input: string): Promise<void> {
  const { wanted, id, project } = await projectCommand(app, input);
  if (!wanted) {
    const current = describeReach(projectReach(project.policy));
    const items: SelectItem[] = Object.entries(NETWORK_CHOICES).map(([value, reach]) => ({
      value,
      label: describeReach(reach),
      description: describeReach(reach) === current ? "current" : "",
    }));
    const picked = await showPicker(app.tui, app.colours, items, {
      title: "Network for this project's commands",
    });
    if (picked) await network(app, `/network ${picked.value}`);
    return;
  }
  const reach = NETWORK_CHOICES[wanted as keyof typeof NETWORK_CHOICES];
  if (!reach)
    throw new Error(
      `Unknown setting ${wanted}. One of: ${Object.keys(NETWORK_CHOICES).join(", ")}.`,
    );
  // Web search is kept, and goes off with the internet (ADR 017).
  const webSearch = reach.internet && (project.policy.network?.webSearch ?? false);
  await app.host.updateProjectPolicy(id, {
    ...project.policy,
    network: { ...reach, webSearch },
  });
  app.host.setNotice({ kind: "info", text: `Network: ${describeReach(reach)}.` });
  await app.host.emitState();
}
