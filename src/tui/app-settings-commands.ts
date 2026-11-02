/** Settings by command: permissions, the model ladder, the local manager, accounts, appearance and this conversation's reasoning. */

import { type SelectItem } from "@earendil-works/pi-tui";
import { conversationReasoningView, isReasoningChoice, reasoningLabel } from "@shared/reasoning";
import { catalogFromProbe } from "@shared/roles";
import { accountLines, parseAccounts, TOKEN_HINT } from "./accounts.js";
import type { CommandSurface } from "./app-command-surface.js";
import { permissionsCommand } from "./app-permissions.js";
import { projectCommand } from "./app-project-commands.js";
import { appearanceLines, parseAppearance } from "./appearance.js";
import { ladderCommand } from "./ladder.js";
import {
  localManagerLines,
  localManagerOff,
  localManagerSettings,
  parseLocalManager,
} from "./local-manager.js";
import { ensureHighlightTheme } from "./markdown-theme.js";
import { showPicker } from "./picker.js";
import { showPrompt } from "./prompt.js";

/** `/permissions …`: Settings → Permissions, for every project on this computer. */
export async function permissions(app: CommandSurface, input: string): Promise<void> {
  const { state, project } = await projectCommand(app, input);
  const result = permissionsCommand(
    {
      settings: state.permissions,
      projects: state.projects,
      catalog: catalogFromProbe({ interactiveModels: state.probe?.interactiveModels ?? [] }),
      project,
    },
    input.trim().replace(/^\S+/, ""),
  );
  if (result.settings) await app.host.savePermissions(result.settings);
  app.host.setNotice({ kind: "info", text: result.notice });
  await app.host.emitState();
}

/** `/ladder …`: Settings → Model ladder. Saving pauses active work, as in the app. */
export async function ladder(app: CommandSurface, input: string): Promise<void> {
  const state = await app.host.getState();
  const catalog = catalogFromProbe({ interactiveModels: state.probe?.interactiveModels ?? [] });
  const result = ladderCommand(state.connection, catalog, input.trim().replace(/^\S+/, ""));
  const saved = result.ladder ? await app.host.saveEscalation(result.ladder) : undefined;
  const paused = saved?.notice?.text;
  app.host.setNotice({
    kind: "info",
    text: paused ? `${result.notice}\n${paused}` : result.notice,
  });
  await app.host.emitState();
}

/**
 * `/local-manager …`: the manager on a model server on this computer. The
 * token is asked for hidden, as `/connect` asks for its own, and the server
 * is tested before anything is saved.
 */
export async function localManager(app: CommandSurface, input: string): Promise<void> {
  const saved = (await app.host.getState()).connection.localManager;
  const parsed = parseLocalManager(input.trim().replace(/^\S+/, ""), saved);
  if (parsed.action === "show") {
    app.host.setNotice({ kind: "info", text: localManagerLines(saved) });
    await app.host.emitState();
    return;
  }
  if (parsed.action === "off") {
    await app.host.saveLocalManager(localManagerOff(saved));
    await app.host.emitState();
    return;
  }
  app.setPrompting(true);
  let token: string | undefined;
  try {
    token = await showPrompt(app.tui, app.colours, {
      title: "Local server token",
      detail: [
        "The token your model server on this computer expects, if any. Stored only on this computer, never shown.",
        saved?.tokenConfigured ? "Enter keeps the saved token." : "Enter for none.",
      ],
      secret: true,
    });
  } finally {
    app.setPrompting(false);
  }
  if (token === undefined) return;
  const { request } = parsed;
  app.setWorking(`Testing ${request.url}`);
  try {
    const probe = await app.host.testLocalManager({
      url: request.url,
      model: request.model,
      token,
    });
    await app.host.saveLocalManager(localManagerSettings(request, probe, saved, token));
  } finally {
    app.setWorking(undefined);
  }
  await app.host.emitState();
}

/** `/accounts …`: Settings → Integrations, with the token asked for hidden. */
export async function accounts(app: CommandSurface, input: string): Promise<void> {
  const { integrations } = await app.host.getState();
  const request = parseAccounts(input.trim().replace(/^\S+/, ""), integrations);
  if (request.action === "show") {
    app.host.setNotice({ kind: "info", text: accountLines(integrations) });
  } else if (request.action === "remove") {
    await app.host.removeForge(request.kind);
  } else {
    app.setPrompting(true);
    let token: string | undefined;
    try {
      token = await showPrompt(app.tui, app.colours, {
        title: `${request.title} token`,
        detail: [
          TOKEN_HINT[request.kind],
          "Stored only on this computer, never shown, never sent to Poundlock.",
          ...(integrations[request.kind]?.configured ? ["Enter keeps the saved token."] : []),
        ],
        secret: true,
      });
    } finally {
      app.setPrompting(false);
    }
    if (token === undefined) return;
    const account = { host: request.host, username: request.username, token };
    if (request.kind === "github") await app.host.saveGithub(account);
    else await app.host.saveGitea(account);
  }
  await app.host.emitState();
}

/** `/appearance …`: Settings → Appearance. The bell is this client's own; the rest is the host's. */
export async function appearance(app: CommandSurface, input: string): Promise<void> {
  const change = parseAppearance(input.trim().replace(/^\S+/, ""), await app.host.getState());
  const saved = await app.preferences.read();
  if (change.action === "theme") {
    await app.host.saveAppearance({ theme: change.theme });
    app.colours.retheme(change.theme);
    ensureHighlightTheme(app.colours);
    // Drawn lines are cached with the old colours.
    app.tui.invalidate();
  }
  if (change.action === "chips")
    await app.host.saveUiPreferences({ composerInfolets: change.composerInfolets });
  if (change.action === "notify") await app.preferences.write({ ...saved, bell: change.bell });
  const bell = change.action === "notify" ? change.bell : saved.bell;
  app.host.setNotice({ kind: "info", text: appearanceLines(await app.host.getState(), bell) });
  await app.host.emitState();
}

/**
 * This conversation's manager reasoning. With no argument, lists what the
 * manager's profile offers and what the next turn will use; `default` goes
 * back to the Manager default.
 */
export async function reasoning(app: CommandSurface, input: string): Promise<void> {
  const { wanted, id, state, project } = await projectCommand(app, input);
  const view = conversationReasoningView({
    project,
    roles: state.connection.roles,
    models: state.probe?.interactiveModels ?? [],
    localManager: Boolean(state.connection.localManager?.enabled && !project.managerEscalation),
  });
  if (!wanted) {
    // An error (an unverified profile, say) explains itself better as text
    // than as a list of choices that may not even apply; only offer the
    // picker once there is a clean set of choices to show in it.
    if (view.error || !view.offered.length) {
      app.host.setNotice({
        kind: view.error ? "error" : "info",
        text: [
          `Manager reasoning for this conversation: ${
            project.reasoningOverride
              ? reasoningLabel(project.reasoningOverride)
              : "Manager default"
          }${view.effective ? ` (next turn: ${reasoningLabel(view.effective)})` : ""}.`,
          `Offered by ${view.profileName ?? "the manager"}: ${view.offered.map((choice) => choice).join(", ")}.`,
          view.error ?? "Change it with /reasoning <setting>, or /reasoning default.",
        ].join("\n"),
      });
      await app.host.emitState();
      return;
    }
    const items: SelectItem[] = [
      ...view.offered.map((choice) => ({ value: choice, label: reasoningLabel(choice) })),
      { value: "default", label: "Manager default" },
    ];
    const picked = await showPicker(app.tui, app.colours, items, {
      title: "Manager reasoning for this conversation",
    });
    if (picked) await reasoning(app, `/reasoning ${picked.value}`);
    return;
  }
  const choice = wanted === "default" ? undefined : wanted;
  if (choice !== undefined && !isReasoningChoice(choice))
    throw new Error(`Unknown setting ${wanted}. One of: ${view.offered.join(", ")}, default.`);
  await app.host.setConversationReasoning(id, choice);
  app.host.setNotice({
    kind: "info",
    text: `Manager reasoning for this conversation: ${
      choice ? reasoningLabel(choice) : "Manager default"
    }. Takes effect from the next turn.`,
  });
  await app.host.emitState();
}
