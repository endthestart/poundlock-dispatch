/**
 * Keys and commands, driven with a stub terminal.
 *
 * The risk here is not painting — it is a keystroke meaning the wrong thing.
 * A letter typed inside a sentence must never answer a decision, and a pending
 * decision must own the keyboard exactly as it blocks the composer.
 */

import { readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { DispatchHost, type HostDependencies } from "@core/host/dispatch-host";
import {
  type ManagerCompactContext,
  type ManagerPort,
  ProjectOrchestrator,
} from "@core/orchestration";
import { parseInteractiveModels } from "@core/poundlock";
import { ProjectLifecycle } from "@core/project-lifecycle";
import type { SelectList } from "@earendil-works/pi-tui";
import {
  matchesKey,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { hostCommandPort } from "@runtime/host-command";
import { catalogFromProbe } from "@shared/roles";
import type { ProjectRecord } from "@shared/types";
import { TuiApp } from "@tui/app";
import { permissionsCommand } from "@tui/app-permissions";
import { SEARCH_KEYS } from "@tui/app-views";
import { Card } from "@tui/card";
import { type Colours, createColours } from "@tui/colour";
import { filePreferences, memoryPreferences, type TuiPreferenceStore } from "@tui/preferences";
import { CONTROL_COMMANDS } from "@tui/render";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";
import {
  countingManager,
  planTask,
  recordingWorker,
  workflowFixture,
} from "./support/workflow-fixture";

/** Ctrl+C as the terminal sends it, written as a code point to stay visible. */
const CTRL_C = String.fromCharCode(3);

/** A terminal that records instead of drawing. */
function stubTui() {
  const listeners: Array<(data: string) => unknown> = [];
  // The last component a picker (or anything else) handed to `showOverlay`,
  // so a test can drive it directly — press a key, read what it shows — the
  // way a real `SelectList` inside a real overlay would be driven.
  let lastOverlay: { component: unknown; hidden: boolean } | undefined;
  // What has the keyboard, so a test can see where keys would go.
  let focused: unknown;
  return {
    // What the editor asks of a terminal when it draws.
    terminal: { rows: 30, columns: 100 },
    listeners,
    lastOverlay: () => lastOverlay,
    focused: () => focused,
    addChild: () => undefined,
    removeChild: () => undefined,
    invalidate: vi.fn(),
    setFocus: (component: unknown) => {
      focused = component;
    },
    showOverlay: (component: unknown) => {
      const entry = { component, hidden: false };
      lastOverlay = entry;
      return {
        hide: () => {
          entry.hidden = true;
        },
        setHidden: (hidden: boolean) => {
          entry.hidden = hidden;
        },
        isHidden: () => entry.hidden,
        focus: () => undefined,
        unfocus: () => undefined,
        isFocused: () => !entry.hidden,
        getBounds: () => undefined,
      };
    },
    start: () => undefined,
    stop: () => undefined,
    requestRender: () => undefined,
    addInputListener: (listener: (data: string) => unknown) => {
      listeners.push(listener);
      return () => undefined;
    },
    removeInputListener: () => undefined,
    onTerminalColorSchemeChange: () => () => undefined,
    setTerminalColorSchemeNotifications: () => undefined,
  };
}

async function appFixture(
  options: { manager?: ManagerPort; preferences?: TuiPreferenceStore; colours?: Colours } = {},
) {
  const fixture = await workflowFixture({ prefix: "tui-app-" });
  const counting = countingManager(fixture.store, { tasks: [planTask("Task one")] });
  const manager = options.manager ?? counting.manager;
  const { worker } = recordingWorker();
  const approvals = new ApprovalBroker(() => {
    void host.emitState();
  });
  const deps: HostDependencies = {
    worker: () => worker,
    managerProvider: () => ({
      get: async () => manager,
      reset: async () => undefined,
      abort: () => undefined,
      clear: () => undefined,
    }),
    orchestrator: (dependencies) =>
      new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        ...dependencies,
        clientFor: async () => fixture.backend,
      }),
    lifecycle: (dependencies) => new ProjectLifecycle(dependencies),
  };
  const host = new DispatchHost(
    { dataRoot: fixture.store.layout.root },
    fixture.store,
    approvals,
    deps,
  );
  await host.selectProject(fixture.project.id);
  // The catalog read on opening: answered at once, so it cannot land after a test's own catalog.
  vi.spyOn(host, "refreshServerInfo").mockResolvedValueOnce(undefined);
  const tui = stubTui();
  const exit = vi.fn();
  // The stub implements only the TUI surface the app actually calls.
  const app = new TuiApp(
    host,
    tui as unknown as ConstructorParameters<typeof TuiApp>[1],
    exit,
    options.colours,
    undefined,
    options.preferences,
  );
  await app.start();
  return { fixture, host, approvals, app, tui, exit };
}

function pendingApproval(projectId: string, projectName: string) {
  return {
    projectId,
    projectName,
    planRevision: 1,
    kind: "bash" as const,
    action: "npm test",
    reason: "run the tests",
    cwd: "/tmp/demo",
  };
}

describe("terminal keys", () => {
  it("answers a pending decision and nothing else", async () => {
    const { fixture, approvals, app, host } = await appFixture();
    const decision = approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();

    // While a decision is open, a run control must not fire.
    expect(app.shortcut("p")).toBeUndefined();
    const allow = app.shortcut("a");
    expect(allow).toBeDefined();
    await allow?.();
    expect(await decision).toBe(true);
  });

  it("denies on d and remembers on s", async () => {
    const { fixture, approvals, app, host } = await appFixture();
    const denied = approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    await app.shortcut("d")?.();
    expect(await denied).toBe(false);

    const remembered = approvals.request({
      ...pendingApproval(fixture.project.id, fixture.project.name),
      action: "npm run build",
    });
    await host.emitState();
    await app.shortcut("s")?.();
    expect(await remembered).toBe(true);
    const saved = (await fixture.store.getPermissions()).grants?.[fixture.project.id] ?? [];
    expect(saved.map((rule) => rule.action)).toContain("npm run build");
  });

  it("never lets a letter act while the user could be typing a sentence", async () => {
    // No decision is pending, so every letter is ordinary text. An input
    // listener runs before the editor, so a letter shortcut here would eat the
    // first character of a word — and, worse, do something with it.
    const { app } = await appFixture();
    for (const key of "always deny it") expect(app.shortcut(key)).toBeUndefined();
    expect(app.shortcut("1")).toBeUndefined();
  });

  it("gives the keyboard back to the composer once a decision is answered", async () => {
    const { fixture, approvals, app, host } = await appFixture();
    const decision = approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    expect(app.shortcut("a")).toBeDefined();
    await app.shortcut("a")?.();
    expect(await decision).toBe(true);
    await host.emitState();
    expect(app.shortcut("a")).toBeUndefined();
  });

  it("consumes a shortcut so it does not also reach the composer", async () => {
    const { fixture, approvals, host, tui } = await appFixture();
    void approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    const results = tui.listeners.map((listener) => listener("a"));
    expect(results).toContainEqual({ consume: true });
  });

  it("passes ordinary typing through to the composer", async () => {
    const { tui } = await appFixture();
    expect(tui.listeners.map((listener) => listener("h"))).toEqual([undefined]);
  });

  it("opens search with a key every terminal sends as it is", () => {
    // Ctrl+/ arrived in iTerm2 as the byte for Ctrl+-, the editor's Undo, and
    // Ctrl+Shift+F needs the Kitty keyboard protocol. Ctrl+R is one byte.
    expect(SEARCH_KEYS[0]).toBe("ctrl+r");
    expect(matchesKey("\x12", SEARCH_KEYS[0])).toBe(true);
    const taken = Object.entries(TUI_KEYBINDINGS)
      .filter(([id]) => id !== "tui.altScreen.search")
      .flatMap(([, binding]) => [binding.defaultKeys].flat());
    expect(taken).not.toContain("ctrl+r");
  });

  it("gives a new approval card the keyboard, with Allow once a bare Enter away", async () => {
    const { fixture, approvals, app, host, tui } = await appFixture();
    const decision = approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    const card = tui.focused() as Card;
    expect(card).toBeInstanceOf(Card);
    expect(card.key).toMatch(/^approval:/);
    card.handleInput("\r");
    expect(await decision).toBe(true);
    void app;
  });

  it("leaves a half-typed message the keyboard until Tab moves to the card", async () => {
    // A card that appears mid-sentence must not take the next Enter or letter.
    const { fixture, approvals, app, host, tui } = await appFixture();
    app.editorForTest().setText("about the deploy");
    approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    expect(tui.focused()).not.toBeInstanceOf(Card);
    expect(app.shortcut("a")).toBeUndefined();
    await app.shortcut("\t")?.();
    expect(tui.focused()).toBeInstanceOf(Card);
    expect(app.shortcut("a")).toBeDefined();
    expect(app.screenForTest()).toBe("conversation");
  });

  it("offers a decision's choices in the card, and Esc hands back the composer", async () => {
    // Only Dispatch's own decisions carry choices; this is a folder request.
    const { fixture, host, tui, app } = await appFixture();
    const project = (await fixture.store.getProject(fixture.project.id))!;
    project.status = "needs_input";
    project.needsInput = {
      question: "May this project read /tmp/other-folder? To reuse its parser.",
      askedAt: new Date().toISOString(),
      kind: "folder_access",
      folder: { path: "/tmp/other-folder", mode: "read", reason: "To reuse its parser." },
      choices: [
        { id: "folder:read", label: "Allow read-only" },
        { id: "folder:deny", label: "Don't allow" },
      ],
    };
    await fixture.store.saveProject(project);
    await host.emitState();
    const card = tui.focused() as Card;
    expect(card.key).toMatch(/^question:/);
    card.handleInput("\x1b");
    expect(tui.focused()).not.toBeInstanceOf(Card);
    // Tab goes back to the card; its list is still there.
    await app.shortcut("\t")?.();
    expect(tui.focused()).toBe(card);
    card.handleInput("\x1b[B");
    card.handleInput("\r");
    // The refusal is a real answer: it reaches the manager as the owner's reply.
    await vi.waitFor(async () => {
      const messages = await fixture.store.getMessages(fixture.project.id);
      expect(
        messages.some((message) => /Not allowed: \/tmp\/other-folder/.test(message.text)),
      ).toBe(true);
    }, 30_000);
  });

  it("leaves a manager's question to the message box", async () => {
    const { fixture, host, tui } = await appFixture();
    const project = (await fixture.store.getProject(fixture.project.id))!;
    project.status = "needs_input";
    project.needsInput = {
      question: "Single user or multi user?",
      askedAt: new Date().toISOString(),
      kind: "question",
    };
    await fixture.store.saveProject(project);
    await host.emitState();
    expect(tui.focused()).not.toBeInstanceOf(Card);
  });

  it("answers a numbered question by typing the number", async () => {
    const { fixture, host, app } = await appFixture();
    const project = (await fixture.store.getProject(fixture.project.id))!;
    project.status = "needs_input";
    project.needsInput = {
      question: "Single user or multi user?",
      askedAt: new Date().toISOString(),
      choices: [
        { id: "single", label: "Single user" },
        { id: "multi", label: "Multi user" },
      ],
    };
    await fixture.store.saveProject(project);
    await host.emitState();

    // A bare digit is typed, not a shortcut, so a reply beginning with a
    // number is never mistaken for a choice.
    expect(app.shortcut("2")).toBeUndefined();
    await app.submitForTest("2");
    const messages = await fixture.store.getMessages(fixture.project.id);
    expect(messages.some((message) => message.text === "multi")).toBe(true);

    // Free text still answers the same question.
    await app.submitForTest("neither, make it single for now");
    const after = await fixture.store.getMessages(fixture.project.id);
    expect(after.some((message) => message.text.startsWith("neither"))).toBe(true);
  });

  it("returns to the conversation when a message is sent from another screen", async () => {
    // Sent from /setup, the reply arrived on a screen that has no transcript.
    const { fixture, app } = await appFixture();
    await app.submitForTest("/setup");
    expect(app.screenForTest()).toBe("setup");
    await app.submitForTest("hi");
    expect(app.screenForTest()).toBe("conversation");
    const messages = await fixture.store.getMessages(fixture.project.id);
    expect(messages.some((message) => message.text === "hi")).toBe(true);
  });

  it("recalls earlier messages with the up arrow, newest first", async () => {
    const { fixture, host } = await appFixture();
    await host.sendMessage("first question", { projectId: fixture.project.id });
    // A restarted client still remembers what was sent before it started.
    const tui = stubTui();
    const restarted = new TuiApp(host, tui as unknown as ConstructorParameters<typeof TuiApp>[1]);
    await restarted.start();
    await restarted.submitForTest("/board");
    const editor = restarted.editorForTest();
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("/board");
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("first question");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    expect(editor.getText()).toBe("");
  });

  it("sets and clears this project's worker permissions with /trust", async () => {
    const { fixture, app } = await appFixture();
    const trust = async () =>
      (await fixture.store.getProject(fixture.project.id))?.policy.toolTrust;
    await app.submitForTest("/trust assist");
    expect(await trust()).toBe("assist");
    await app.submitForTest("/trust default");
    expect(await trust()).toBeUndefined();
  });

  it("refuses an unknown /trust mode without changing anything", async () => {
    const { fixture, host, app } = await appFixture();
    await app.submitForTest("/trust yolo");
    expect((await host.getState()).notice?.text).toMatch(/Unknown mode yolo/);
    expect((await fixture.store.getProject(fixture.project.id))?.policy.toolTrust).toBeUndefined();
  });

  it("handles every command the actions line can advertise", async () => {
    // The line once offered /override and /retry, which fell through to
    // "Unknown command".
    const { host, app } = await appFixture();
    for (const command of Object.values(CONTROL_COMMANDS)) {
      await app.submitForTest(command.replace(" <reason>", " because"));
      expect((await host.getState()).notice?.text ?? "").not.toMatch(/Unknown command/);
    }
  });

  it("lists the commands for /help, as typing / does", async () => {
    const { host, app } = await appFixture();
    await app.submitForTest("/help");
    const text = (await host.getState()).notice?.text ?? "";
    expect(text).not.toMatch(/Unknown command/);
    expect(text).toMatch(/\/board +Show the plan and task board\./);
    expect(text).toContain("/role <role> [profile]");
  });

  it("never leaves on a single ctrl+c", async () => {
    // One keystroke ending a session you were mid-sentence in is the way to
    // lose work. The first press abandons what you typed; only a second,
    // with nothing left to abandon, exits.
    const { app, exit, host } = await appFixture();
    const stopped = vi.spyOn(host, "shutdown");

    await app.shortcut(CTRL_C)?.();
    expect(stopped).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    await app.shortcut(CTRL_C)?.();
    expect(stopped).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("spends the first ctrl+c clearing the composer, not exiting", async () => {
    const { app, exit } = await appFixture();
    app.editorForTest().setText("a half-written message");

    await app.shortcut(CTRL_C)?.();
    expect(app.editorForTest().getText()).toBe("");
    expect(exit).not.toHaveBeenCalled();

    // And clearing does not leave the session one keystroke from ending.
    await app.shortcut(CTRL_C)?.();
    expect(exit).not.toHaveBeenCalled();
    await app.shortcut(CTRL_C)?.();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("choosing models from the terminal", () => {
  /** The catalog `refreshServerInfo` would fetch, without a controller. */
  function servedCatalog(host: DispatchHost) {
    vi.spyOn(host, "refreshServerInfo").mockResolvedValue(undefined);
    Object.defineProperty(host.discovery, "probe", {
      configurable: true,
      value: {
        ok: true,
        permissions: ["models:read", "inference:invoke", "external:invoke"],
        interactiveModels: [
          {
            id: "orion-fast",
            context_tokens: 32768,
            max_output_tokens: 4096,
            dataDestination: "operator_network",
            workload_class: "interactive-coding",
            poundlock: { profile_id: "orion-id", routing_revision: "rev-orion" },
          },
          {
            id: "frontier-gpt-sol",
            context_tokens: 200000,
            max_output_tokens: 8192,
            dataDestination: "external",
            workload_class: "interactive-coding",
            poundlock: { profile_id: "frontier-id", routing_revision: "rev-frontier" },
          },
        ],
        durableModels: [],
      },
    });
  }

  it("lists what Poundlock is serving", async () => {
    // Until this existed a terminal-only user could not even see the profile
    // names, let alone choose between them.
    const { app, host } = await appFixture();
    servedCatalog(host);
    await app.submitForTest("/models");
    const notice = (await host.getState()).notice;
    expect(notice?.kind).toBe("info");
    expect(notice?.text).toContain("orion-fast");
    expect(notice?.text).toContain("frontier-gpt-sol");
    expect(notice?.text).toContain("External provider");
  });

  it("binds a role to a profile, which is the whole point", async () => {
    // "A frontier model as the project manager, orion as the worker" was
    // simply not expressible here: /approve-models re-approves the map that
    // already exists and /setup is read-only, so the desktop app was the only
    // way to choose a manager.
    const { app, host, fixture } = await appFixture();
    servedCatalog(host);
    await app.submitForTest("/role manager frontier-gpt-sol");
    await app.submitForTest("/role interactive orion-fast");

    const roles = (await fixture.store.getConnection()).roles;
    expect(roles.manager?.profileName).toBe("frontier-gpt-sol");
    expect(roles.manager?.approvedDataDestination).toBe("external");
    expect(roles.interactive?.profileName).toBe("orion-fast");
  });

  it("sets up a fresh connection one role at a time, holding the first until the worker is chosen", async () => {
    // The host saves a model map only with both roles in it, so binding the
    // manager alone on a fresh connection was refused, and so was the worker.
    const { app, host, fixture } = await appFixture();
    servedCatalog(host);
    await fixture.store.saveConnection({ ...(await fixture.store.getConnection()), roles: {} });
    const notice = async () => (await host.getState()).notice?.text ?? "";

    await app.submitForTest("/role manager frontier-gpt-sol");
    expect((await fixture.store.getConnection()).roles).toEqual({});
    expect(await notice()).toContain("/role worker");
    // The destination in words, as /models says it.
    expect(await notice()).toContain("frontier-gpt-sol (External provider)");

    // "Worker" is what the app and the refusal call the interactive role.
    await app.submitForTest("/role worker orion-fast");
    const roles = (await fixture.store.getConnection()).roles;
    expect(roles.manager?.profileName).toBe("frontier-gpt-sol");
    expect(roles.interactive?.profileName).toBe("orion-fast");
  });

  it("builds the model ladder: adds, orders and removes rungs, and sets how moves are authorised", async () => {
    const { app, host, fixture } = await appFixture();
    servedCatalog(host);
    const ladder = async () => (await fixture.store.getConnection()).escalation;
    const notice = async () => (await host.getState()).notice?.text;
    await app.submitForTest("/ladder add orion-fast");
    await app.submitForTest("/ladder add frontier-gpt-sol");
    await app.submitForTest("/ladder up 2");
    expect((await ladder())?.profiles.map((rung) => rung.profileName)).toEqual([
      "frontier-gpt-sol",
      "orion-fast",
    ]);
    expect(await notice()).toMatch(/^Base worker \(rung 0\): .*\nRung 1: frontier-gpt-sol · /);
    expect(await notice()).toContain("Active work is paused");
    await app.submitForTest("/ladder add orion-fast");
    expect(await notice()).toBe("orion-fast is already a rung.");
    await app.submitForTest("/ladder standing");
    await app.submitForTest("/ladder limit 5");
    await app.submitForTest("/ladder remove 1");
    expect(await ladder()).toMatchObject({
      profiles: [{ profileName: "orion-fast" }],
      mode: "standing",
      maxTransitionsPerRun: 5,
    });
    await app.submitForTest("/ladder limit 21");
    expect(await notice()).toMatch(/^Usage: \/ladder/);
    expect((await ladder())?.maxTransitionsPerRun).toBe(5);
  });

  it("saves a destination override, which can never downgrade an external route", async () => {
    const { app, host, fixture } = await appFixture();
    servedCatalog(host);
    const notice = async () => (await host.getState()).notice?.text ?? "";
    const preference = async (id: string) =>
      (await fixture.store.getConnection()).profiles?.[id]?.approvedDestination;
    await app.submitForTest("/models frontier-gpt-sol destination own");
    expect(await preference("frontier-gpt-sol")).toBe("operator_network");
    expect(await notice()).toContain("Destination: External provider (your override;");
    await app.submitForTest("/models frontier-gpt-sol destination reported");
    expect(await preference("frontier-gpt-sol")).toBeUndefined();
    expect(await notice()).toContain("Destination: External provider (reported by Poundlock)");
    await app.submitForTest("/models frontier-gpt-sol destination elsewhere");
    expect(await notice()).toMatch(/^Usage: \/models <profile> destination/);
  });

  it("refuses a role or a profile it cannot resolve, rather than guessing", async () => {
    const { app, host } = await appFixture();
    servedCatalog(host);

    await app.submitForTest("/role manager no-such-model");
    expect((await host.getState()).notice?.text).toMatch(/No profile named no-such-model/);

    await app.submitForTest("/role wizard orion-fast");
    expect((await host.getState()).notice?.text).toMatch(/Unknown role wizard/);

    // The Background jobs role is gone, so a habit from before gets the same
    // refusal as any other name that is not a role.
    await app.submitForTest("/role durable orion-fast");
    expect((await host.getState()).notice?.text).toMatch(/Unknown role durable/);
  });

  it("refuses a profile that cannot serve the role, before saving it", async () => {
    // The desktop picker applies this check; the terminal saved the binding
    // and let the first turn refuse it minutes later.
    const { app, host, fixture } = await appFixture();
    servedCatalog(host);
    const before = (await fixture.store.getConnection()).roles.snippet;
    await app.submitForTest("/role snippet orion-fast");
    expect((await host.getState()).notice?.text).toMatch(/cannot serve snippet/);
    expect((await fixture.store.getConnection()).roles.snippet).toEqual(before);
  });

  it("will not save a newly chosen model that Poundlock no longer serves", async () => {
    const { host, fixture } = await appFixture();
    servedCatalog(host);
    const roles = (await fixture.store.getConnection()).roles;
    await expect(
      host.saveModels({
        ...roles,
        manager: { profileId: "removed-id", profileName: "vega-old", source: "interactive" },
      }),
    ).rejects.toThrow(/vega-old is no longer served/);
  });

  it("will not save a manager and worker that share a model slot, or a disabled model", async () => {
    const { host } = await appFixture();
    vi.spyOn(host, "refreshServerInfo").mockResolvedValue(undefined);
    const local = (id: string, status: "enabled" | "disabled" = "enabled") => ({
      id,
      context_tokens: 32768,
      max_output_tokens: 4096,
      dataDestination: "operator_network",
      workload_class: "interactive-coding",
      status,
      occupancy: {
        kind: null,
        slot: "orion/llamacpp",
        node_id: "orion",
        runtime_profile: "llamacpp",
      },
      profileId: `${id}-id`,
    });
    Object.defineProperty(host.discovery, "probe", {
      configurable: true,
      value: {
        ok: true,
        permissions: ["models:read", "inference:invoke"],
        interactiveModels: [local("orion-a"), local("orion-b"), local("orion-off", "disabled")],
        durableModels: [],
      },
    });
    const bind = (name: string) => ({
      profileId: `${name}-id`,
      profileName: name,
      source: "interactive" as const,
    });
    await expect(
      host.saveModels({ manager: bind("orion-a"), interactive: bind("orion-b") }),
    ).rejects.toThrow(/share one machine's model slot/);
    await expect(
      host.saveModels({ manager: bind("orion-a"), interactive: bind("orion-off") }),
    ).rejects.toThrow(/orion-off is disabled in Poundlock/);
  });

  it("will not save a local fallback that sends work to a provider", async () => {
    const { host, fixture } = await appFixture();
    servedCatalog(host);
    const roles = (await fixture.store.getConnection()).roles;
    await expect(
      host.saveModels({
        ...roles,
        fallback: {
          profileId: "frontier-gpt-sol",
          profileName: "frontier-gpt-sol",
          source: "interactive",
        },
      }),
    ).rejects.toThrow(/must run on your own network/);
    expect((await fixture.store.getConnection()).roles.fallback).toBeUndefined();
  });

  it("opens a picker for /role with no profile named, listing every profile Poundlock serves", async () => {
    const { app, tui, host, fixture } = await appFixture();
    servedCatalog(host);
    const submitted = app.submitForTest("/role manager");
    // The picker awaits a selection before /role's own work resumes.
    await vi.waitFor(() => expect(tui.lastOverlay()).toBeDefined());
    const list = tui.lastOverlay()!.component as SelectList;
    // frontier-gpt-sol is listed second in `servedCatalog`.
    list.handleInput("\x1b[B"); // down, to frontier-gpt-sol
    list.handleInput("\r"); // confirm
    await submitted;
    const roles = (await fixture.store.getConnection()).roles;
    expect(roles.manager?.profileName).toBe("frontier-gpt-sol");
  });

  it("opens the /role picker on the current binding, so Enter keeps it", async () => {
    // The app's setup pre-fills its role pickers the same way.
    const { app, tui, host, fixture } = await appFixture();
    servedCatalog(host);
    await app.submitForTest("/role manager frontier-gpt-sol");
    const submitted = app.submitForTest("/role manager");
    await vi.waitFor(() => expect(tui.lastOverlay()?.hidden).toBe(false));
    (tui.lastOverlay()!.component as SelectList).handleInput("\r");
    await submitted;
    expect((await fixture.store.getConnection()).roles.manager?.profileName).toBe(
      "frontier-gpt-sol",
    );
  });

  it("gives a project its own manager and worker, and refuses a profile not served", async () => {
    const { app, host, fixture } = await appFixture();
    servedCatalog(host);
    const policy = async () => (await fixture.store.getProject(fixture.project.id))?.policy;
    const notice = async () => (await host.getState()).notice?.text;
    await app.submitForTest("/project-model worker orion-fast");
    expect((await policy())?.workerModel).toBe("orion-fast");
    expect(await notice()).toBe("This project's worker now runs on orion-fast (operator_network).");
    await app.submitForTest("/project-model manager frontier-gpt-sol");
    expect((await policy())?.managerModel).toBe("frontier-gpt-sol");
    await app.submitForTest("/project-model");
    expect(await notice()).toBe("This project's Manager: frontier-gpt-sol. Worker: orion-fast.");
    await app.submitForTest("/project-model worker default");
    expect((await policy())?.workerModel).toBeUndefined();
    await app.submitForTest("/project-model worker nonesuch");
    expect(await notice()).toContain("No profile named nonesuch.");
    await app.stop();
  });

  it("says where one model's data goes, how it is reached and what serves it", async () => {
    const { app, host } = await appFixture();
    servedCatalog(host);
    await app.submitForTest("/models frontier-gpt-sol");
    const text = (await host.getState()).notice?.text ?? "";
    expect(text.split("\n")[0]).toBe("frontier-gpt-sol");
    expect(text).toContain("Destination:");
    expect(text).toContain("Transport:");
    expect(text).toContain("Thinking: the model's own default");
    await app.stop();
  });
});

describe("pickers, shown as overlays instead of a printed list", () => {
  it("opens a picker for bare /trust; picking a mode applies it", async () => {
    const { app, tui, fixture } = await appFixture();
    const submitted = app.submitForTest("/trust");
    await vi.waitFor(() => expect(tui.lastOverlay()).toBeDefined());
    const list = tui.lastOverlay()!.component as SelectList;
    list.handleInput("\x1b[B"); // down, from "ask" to "assist"
    list.handleInput("\r"); // confirm
    await submitted;
    expect((await fixture.store.getProject(fixture.project.id))?.policy.toolTrust).toBe("assist");
  });

  it("changes nothing when the picker is cancelled", async () => {
    const { app, tui, fixture } = await appFixture();
    const submitted = app.submitForTest("/trust");
    await vi.waitFor(() => expect(tui.lastOverlay()).toBeDefined());
    const list = tui.lastOverlay()!.component as SelectList;
    list.handleInput("\x1b"); // escape: cancel
    await submitted;
    expect((await fixture.store.getProject(fixture.project.id))?.policy.toolTrust).toBeUndefined();
  });
});

describe("the screen as drawn", () => {
  const WIDTHS = [80, 100, 120];
  const screen = (app: TuiApp, width: number) =>
    app.renderForTest(width).map((line) => stripTerminalSequences(line));

  function expectInside(lines: string[], width: number, what: string) {
    for (const line of lines)
      expect(visibleWidth(line), `${what} at ${width}: ${line}`).toBeLessThanOrEqual(width);
  }

  it("keeps every line inside the terminal, screen by screen, at 80, 100 and 120 columns", async () => {
    const { fixture, host, approvals, app } = await appFixture();
    for (const width of WIDTHS) expectInside(screen(app, width), width, "empty");

    // A plan waiting for approval: the card, the title bar and the status.
    await host.sendMessage("Build the thing", { projectId: fixture.project.id });
    for (const width of WIDTHS) {
      const lines = screen(app, width);
      expectInside(lines, width, "plan");
      expect(lines.join("\n")).toContain("Proposed plan");
    }

    await app.submitForTest("/board");
    for (const width of WIDTHS) expectInside(screen(app, width), width, "board");
    await app.submitForTest("/setup");
    for (const width of WIDTHS) expectInside(screen(app, width), width, "setup");
    await app.submitForTest("/chat");

    void approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    for (const width of WIDTHS) {
      const lines = screen(app, width);
      expectInside(lines, width, "approval");
      expect(lines.join("\n")).toContain("Decision needed");
    }
  });

  it("says who it is and what state it is in at the top, whatever the screen", async () => {
    const { fixture, app } = await appFixture();
    for (const command of ["/chat", "/board", "/setup"]) {
      await app.submitForTest(command);
      const [bar, rule] = screen(app, 100);
      expect(bar, command).toContain(fixture.project.name);
      expect(rule, command).toBe("─".repeat(100));
    }
  });

  it("sets what the composer will do into its border, and says why when it will not send", async () => {
    const { fixture, approvals, host, app } = await appFixture();
    // The last box on the screen is the composer; a card, when there is one, is above it.
    const box = (width: number) =>
      screen(app, width)
        .filter((line) => line.startsWith("╭─ "))
        .at(-1) ?? "";
    expect(box(100)).toMatch(/^╭─ .*(Ask|Describe|discuss).* ─+╮$/);

    void approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    // The whole sentence when it fits, its first sentence when it does not.
    expect(box(120)).toContain(
      "Decide the approval card before sending. Sending does not allow the action.",
    );
    expect(box(70)).toContain("Decide the approval card before sending.");
    expect(box(70)).not.toContain("Sending does not");
    expect(visibleWidth(box(70))).toBe(70);
  });

  it("keeps the exact command on screen when the terminal is too short for the whole card", async () => {
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { value: 20, configurable: true });
    try {
      const { fixture, approvals, host, app } = await appFixture();
      void approvals.request({
        ...pendingApproval(fixture.project.id, fixture.project.name),
        action: "npm run build -- --mode production",
        reason: "Build it so the result can be checked. ".repeat(6),
      });
      await host.emitState();
      const lines = screen(app, 80);
      const top = lines.findIndex((line) => line.startsWith("╭─ Decision needed"));
      const bottom = lines.findIndex((line, index) => index > top && line.startsWith("╰"));
      const card = lines.slice(top, bottom + 1);
      expect(card.join("\n")).toContain("npm run build -- --mode production");
      expect(card.join("\n")).toMatch(/… \d+ more lines?/);
      // The answers are still there to choose from.
      expect(card.join("\n")).toContain("Allow once");
      expect(card.length).toBeLessThanOrEqual(11);
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });

  it("shows the keys that do something now, the state's own actions first", async () => {
    const { fixture, host, app } = await appFixture();
    const keys = () => screen(app, 120).at(-1) ?? "";
    expect(keys()).toContain("Enter send");
    expect(keys()).toContain("/ commands");

    await host.sendMessage("Build the thing", { projectId: fixture.project.id });
    expect(keys()).toMatch(/^ {2}\/approve Approve and start/);

    await app.submitForTest("/board");
    expect(keys()).toContain("Tab back to chat");
    expect(keys()).not.toContain("Enter send");
  });

  it("says in the key line when a command is not one", async () => {
    const { app } = await appFixture();
    await app.submitForTest("/nope");
    expect(screen(app, 100).at(-1)).toContain("Unknown command /nope. Type / to see the commands.");
  });

  it("says what a slow command is doing while it waits, with a spinner beside it", async () => {
    const { app, host } = await appFixture();
    let finish: () => void = () => undefined;
    vi.spyOn(host, "refreshServerInfo").mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const done = app.submitForTest("/models");
    await vi.waitFor(() =>
      expect(screen(app, 100).join("\n")).toContain("Asking Poundlock for its models…"),
    );
    expect(screen(app, 100).join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Asking Poundlock for its models…/);
    finish();
    await done;
    expect(screen(app, 100).join("\n")).not.toContain("Asking Poundlock for its models…");
    await app.stop();
  });

  it("puts an error where it is seen, marked so it reads without colour", async () => {
    const { app } = await appFixture();
    await app.submitForTest("/trust yolo");
    const lines = screen(app, 100);
    const error = lines.find((line) => line.trimStart().startsWith("! Unknown mode yolo"));
    expect(error).toBeDefined();
  });

  it("dims the composer while a card has the keyboard, and lights it when it is the thing to type into", async () => {
    // The border's colour is state: the accent when the composer has the keys.
    const { fixture, approvals, host, app, tui } = await appFixture();
    const before = app.renderForTest(100).join("\n");
    void approvals.request(pendingApproval(fixture.project.id, fixture.project.name));
    await host.emitState();
    expect(tui.focused()).toBeInstanceOf(Card);
    const during = app.renderForTest(100).join("\n");
    expect(during).toContain("Decide the approval card");
    expect(before).not.toContain("Decide the approval card");
  });
});

describe("compaction in the terminal", () => {
  const screen = (app: TuiApp, width = 100) =>
    app.renderForTest(width).map((line) => stripTerminalSequences(line));
  /** The conversation's notices, each line without the bar and margin the terminal sets them off with. */
  const notices = (app: TuiApp) =>
    screen(app, 100)
      .filter((line) => line.trimStart().startsWith("▎"))
      .map((line) => line.replace(/^\s*▎ /, "").trim());
  const USAGE = { tokens: 23_600, windowTokens: 32_768, autoCompactAtTokens: 24_576 };

  /** A manager that answers, reports the context it is using, and compacts as told. */
  function compactingManager(
    script: {
      usage?: { tokens: number; windowTokens: number; autoCompactAtTokens: number };
      during?: (ctx: Parameters<ManagerPort["runTurn"]>[0]) => void;
      outcome?: import("@shared/compaction").CompactOutcome;
    } = {},
  ) {
    const compactions: ManagerCompactContext[] = [];
    const manager: ManagerPort = {
      async runTurn(ctx) {
        script.during?.(ctx);
        if (script.usage) ctx.onContextUsage?.(script.usage);
        return { text: "Understood.", toolTrace: [] };
      },
      async compact(ctx) {
        compactions.push(ctx);
        return (
          script.outcome ?? {
            status: "compacted",
            reason: "manual",
            tokensBefore: 18_340,
            tokensAfter: 5_410,
            summarisedMessages: 14,
            keptMessages: 5,
          }
        );
      },
    };
    return { manager, compactions };
  }

  it("compacts the conversation with /compact, passing the instructions through", async () => {
    const { manager, compactions } = compactingManager();
    const { app, fixture } = await appFixture({ manager });
    await app.submitForTest("/compact Keep the slug decisions.");
    expect(compactions).toHaveLength(1);
    expect(compactions[0].project.id).toBe(fixture.project.id);
    expect(compactions[0].instructions).toBe("Keep the slug decisions.");

    await app.submitForTest("/compact");
    expect(compactions[1].instructions).toBeUndefined();
  });

  it("puts a notice in the conversation, set apart, saying what was kept", async () => {
    const { manager } = compactingManager();
    const { app } = await appFixture({ manager });
    await app.submitForTest("/compact");
    const lines = screen(app, 100);
    const text = lines.join("\n");
    // The bar the terminal sets a notice apart with, on every line of it.
    expect(notices(app).length).toBeGreaterThan(1);
    const flat = notices(app).join(" ");
    expect(flat).toContain("Conversation compacted at your request.");
    expect(flat).toContain("went from about 18,300 to about 5,400 tokens");
    expect(flat).toContain("14 earlier messages are now a summary");
    expect(flat).toContain("project brief stays pinned");
    // And the short line the client keeps on screen.
    expect(text).toContain("Conversation compacted: about 18,300 down to about 5,400 tokens.");
  });

  it("shows a compaction the manager ran on its own during a turn", async () => {
    const { manager } = compactingManager({
      during: (ctx) =>
        ctx.onCompaction?.({
          status: "compacted",
          reason: "threshold",
          tokensBefore: 7_000,
          tokensAfter: 2_600,
          summarisedMessages: 6,
          keptMessages: 3,
        }),
    });
    const { app, fixture, host } = await appFixture({ manager });
    await host.sendMessage("Keep going", { projectId: fixture.project.id });
    const flat = notices(app).join(" ");
    expect(flat).toContain("Conversation compacted automatically");
    expect(flat).toContain("6 earlier messages are now a summary");
  });

  it("says when there was nothing to compact, and when the manager cannot", async () => {
    const { manager } = compactingManager({ outcome: { status: "nothing", why: "too_small" } });
    const { app } = await appFixture({ manager });
    await app.submitForTest("/compact");
    expect(screen(app, 100).join("\n")).toContain("Nothing to compact yet");

    const none = await appFixture();
    await none.app.submitForTest("/compact");
    expect(screen(none.app, 100).join("\n")).toContain("This manager keeps no conversation");
  });

  it("names the reason in the notice line when a compaction cannot run", async () => {
    const { manager } = compactingManager();
    manager.compact = async () => {
      throw new Error("The model did not answer.");
    };
    const { app } = await appFixture({ manager });
    await app.submitForTest("/compact");
    expect(screen(app, 120).join("\n")).toContain(
      "The conversation could not be compacted: The model did not answer.",
    );
  });

  it("shows how full the context is on the status line, and offers /compact once it is worth it", async () => {
    const { manager } = compactingManager({ usage: USAGE });
    const { app, fixture, host } = await appFixture({ manager });
    const status = () => screen(app, 120).join("\n");
    const keys = () => screen(app, 120).at(-1) ?? "";
    expect(status()).not.toContain("context ");
    expect(keys()).not.toContain("/compact");

    await host.sendMessage("Keep going", { projectId: fixture.project.id });
    expect(status()).toContain("context 72% used");
    expect(keys()).toContain("/compact free up context");

    const quiet = compactingManager({
      usage: { tokens: 8_000, windowTokens: 32_768, autoCompactAtTokens: 24_576 },
    });
    const calm = await appFixture({ manager: quiet.manager });
    await calm.host.sendMessage("Keep going", { projectId: calm.fixture.project.id });
    const calmScreen = screen(calm.app, 120).join("\n");
    expect(calmScreen).toContain("context 24% used");
    expect(calmScreen.split("\n").at(-1)).not.toContain("/compact");
  });

  it("starts over after a compaction, reading the new size until the model answers again", async () => {
    const { manager } = compactingManager({ usage: USAGE });
    const original = manager.compact!;
    manager.compact = async (ctx) => {
      const outcome = await original(ctx);
      ctx.onContextUsage?.({ ...USAGE, tokens: 5_410 });
      return outcome;
    };
    const { app, fixture, host } = await appFixture({ manager });
    await host.sendMessage("Keep going", { projectId: fixture.project.id });
    expect(screen(app, 120).join("\n")).toContain("context 72% used");
    await app.submitForTest("/compact");
    expect(screen(app, 120).join("\n")).toContain("context 17% used");
    expect(screen(app, 120).at(-1)).not.toContain("/compact free up context");
  });
});

describe("/transcript", () => {
  it("remembers Normal or Verbose on this computer, and refuses anything else", async () => {
    const file = join(await tempDir("tui-preferences-"), "tui-preferences.json");
    const { app, host } = await appFixture({ preferences: filePreferences(file) });
    await app.submitForTest("/transcript verbose");
    expect((await host.getState()).notice?.text).toBe(
      "Transcript: Verbose. Every step and update, as it happened.",
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      transcriptDensity: "verbose",
      bell: true,
    });
    expect((await filePreferences(file).read()).transcriptDensity).toBe("verbose");
    await app.submitForTest("/transcript loud");
    expect((await host.getState()).notice?.text).toBe("Usage: /transcript [normal|verbose]");
    await app.stop();
  });
});

describe("opening a connected client", () => {
  it("reads what Poundlock serves, so models are named rather than shown by id", async () => {
    const { app, host } = await appFixture();
    expect(host.refreshServerInfo).toHaveBeenCalledTimes(1);
    await app.stop();
  });
});

describe("/appearance", () => {
  it("saves the theme, the bell and the composer chips, and refuses an unknown theme", async () => {
    const preferences = memoryPreferences();
    const { app, host } = await appFixture({ preferences });
    const notice = async () => (await host.getState()).notice?.text;
    await app.submitForTest("/appearance theme latte");
    expect((await host.getState()).appearance.theme).toBe("latte");
    await app.submitForTest("/appearance notify off");
    expect(await preferences.read()).toEqual({ transcriptDensity: "normal", bell: false });
    await app.submitForTest("/appearance chip budget off");
    expect((await host.getState()).ui.composerInfolets).toEqual(["context"]);
    expect(await notice()).toBe(
      [
        "Theme: latte, shared with the desktop app.",
        "Bell when a project needs you or a run stops building: off.",
        "Beside the composer: context.",
      ].join("\n"),
    );
    await app.submitForTest("/appearance theme neon");
    expect(await notice()).toMatch(/^Usage: \/appearance/);
    expect((await host.getState()).appearance.theme).toBe("latte");
    await app.stop();
  });

  it("repaints this client in the new theme at once", async () => {
    const options = { theme: "mocha" as const, isTTY: true, env: { COLORTERM: "truecolor" } };
    const colours = createColours(options);
    const { app, tui } = await appFixture({ colours });
    const latte = createColours({ ...options, theme: "latte" }).paint("accent", "x");
    expect(colours.paint("accent", "x")).not.toBe(latte);
    await app.submitForTest("/appearance theme latte");
    expect(colours.paint("accent", "x")).toBe(latte);
    expect(tui.invalidate).toHaveBeenCalled();
    await app.stop();
  });
});

describe("/new and /new-run", () => {
  it("starts a new conversation once confirmed, and changes nothing when cancelled", async () => {
    const { app, tui, host, fixture } = await appFixture();
    await host.sendMessage("Plan a small change", { projectId: fixture.project.id });
    expect((await host.getState()).snapshot?.messages.length).toBeGreaterThan(0);

    const cancelled = app.submitForTest("/new-run");
    await vi.waitFor(() => expect(tui.lastOverlay()).toBeDefined());
    (tui.lastOverlay()!.component as SelectList).handleInput("\x1b");
    await cancelled;
    expect((await host.getState()).snapshot?.messages.length).toBeGreaterThan(0);

    const confirmed = app.submitForTest("/new");
    await vi.waitFor(() => expect(tui.lastOverlay()?.hidden).toBe(false));
    (tui.lastOverlay()!.component as SelectList).handleInput("\r");
    await confirmed;
    const state = await host.getState();
    expect(state.snapshot?.messages).toEqual([]);
    expect(state.notice?.text).toContain("A new manager conversation is ready");
    await app.stop();
  });
});

describe("/archive and /remove", () => {
  /** Confirm (Enter) or cancel (Escape) the picker a command opened. */
  async function answer(tui: ReturnType<typeof stubTui>, submitted: Promise<void>, key: string) {
    await vi.waitFor(() => expect(tui.lastOverlay()?.hidden).toBe(false));
    (tui.lastOverlay()!.component as SelectList).handleInput(key);
    await submitted;
  }

  it("archives the project once confirmed, then closes and says so", async () => {
    const { app, tui, fixture, exit } = await appFixture();
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await answer(tui, app.submitForTest("/archive"), "\x1b");
    expect(exit).not.toHaveBeenCalled();
    expect((await fixture.store.getProject(fixture.project.id))?.archived).toBeFalsy();
    await answer(tui, app.submitForTest("/archive"), "\r");
    expect((await fixture.store.getProject(fixture.project.id))?.archived).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
    expect(written.mock.calls.map(([text]) => String(text)).join("")).toMatch(/archived/i);
    written.mockRestore();
  });

  it("removes Dispatch's records once confirmed and leaves the folder", async () => {
    const { app, tui, fixture, exit } = await appFixture();
    const folder =
      fixture.project.source.kind === "local_folder" ? fixture.project.source.originalPath : "";
    const written = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await answer(tui, app.submitForTest("/remove"), "\r");
    written.mockRestore();
    expect(
      (await fixture.store.listProjects()).some((project) => project.id === fixture.project.id),
    ).toBe(false);
    expect(await realpath(folder)).toBeTruthy();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("/task", () => {
  it("opens a board task's evidence by its number, and /chat returns", async () => {
    const { app, host, fixture } = await appFixture();
    await host.sendMessage("Plan a small change", { projectId: fixture.project.id });
    await vi.waitFor(async () =>
      expect((await host.getState()).snapshot?.tasks.length).toBeGreaterThan(0),
    );
    await app.submitForTest("/board");
    expect(app.renderForTest(100).map(stripTerminalSequences).join("\n")).toContain("1. Task one");
    await app.submitForTest("/task 1");
    expect(app.screenForTest()).toBe("task");
    const shown = app.renderForTest(100).map(stripTerminalSequences).join("\n");
    expect(shown).toContain("Task one");
    expect(shown).toContain("Fix rounds");
    await app.submitForTest("/task 5");
    expect((await host.getState()).notice?.text).toMatch(/^There is no task 5/);
    await app.submitForTest("/chat");
    expect(app.screenForTest()).toBe("conversation");
    await app.stop();
  });
});

describe("the guided /autopilot start", () => {
  it("asks the app's questions one at a time and starts the run through the host", async () => {
    const { app, host, tui, fixture } = await appFixture();
    await host.updateProjectPolicy(fixture.project.id, {
      ...fixture.project.policy,
      verification: { ...fixture.project.policy.verification, commands: ["npm test"] },
    });
    const start = vi.spyOn(host, "autopilotStart").mockResolvedValue(await host.getState());
    const refresh = vi.spyOn(host, "refreshServerInfo").mockResolvedValue();
    const typed = ["python:3.14-slim", "", ""];
    const titles: string[] = [];
    const submitted = app.submitForTest("/autopilot start");
    let settled = false;
    void submitted.finally(() => {
      settled = true;
    });
    let seen: unknown;
    while (!settled) {
      await vi.waitFor(() => {
        const overlay = tui.lastOverlay();
        expect(settled || (overlay && !overlay.hidden && overlay.component !== seen)).toBe(true);
      });
      if (settled) break;
      const overlay = tui.lastOverlay()!;
      seen = overlay.component;
      const box = overlay.component as {
        constructor: { name: string };
        handleInput(data: string): void;
        render(width: number): string[];
      };
      // Read before the first question: whether the Planner is external decides the rest.
      expect(refresh).toHaveBeenCalled();
      titles.push(stripTerminalSequences(box.render(80).join(" ")));
      // A question waiting on the owner is not work in progress.
      expect(app.renderForTest(100).map(stripTerminalSequences).join("\n")).not.toContain(
        "Autopilot…",
      );
      const keys = box.constructor.name === "PickerBox" ? "\r" : `${typed.shift() ?? ""}\r`;
      for (const key of keys) box.handleInput(key);
      await new Promise((settle) => setTimeout(settle, 0));
    }
    await submitted;
    expect(titles).toHaveLength(6);
    expect(titles[0]).toContain("Toolchain image");
    expect(start).toHaveBeenCalledWith(
      {
        image: "python:3.14-slim",
        hours: 6,
        allowDependencyDownloads: false,
        acceptAlreadyMet: false,
        prepare: [],
      },
      { projectId: fixture.project.id },
    );
    await app.stop();
  });
});

describe("/history", () => {
  it("lists the conversation /new set aside, and /chat returns", async () => {
    const { app, tui, host, fixture } = await appFixture();
    await host.sendMessage("Plan a small change", { projectId: fixture.project.id });
    const confirmed = app.submitForTest("/new");
    await vi.waitFor(() => expect(tui.lastOverlay()).toBeDefined());
    (tui.lastOverlay()!.component as SelectList).handleInput("\r");
    await confirmed;
    await app.submitForTest("/history");
    expect(app.screenForTest()).toBe("history");
    const shown = app.renderForTest(100).map(stripTerminalSequences).join("\n");
    expect(shown).toContain("History");
    expect(shown).toContain("You: Plan a small change");
    await app.submitForTest("/chat");
    expect(app.screenForTest()).toBe("conversation");
    await app.stop();
  });
});

describe("/checks", () => {
  it("adds, lists and removes the project's verification commands", async () => {
    const { app, host, fixture } = await appFixture();
    const saved = async () =>
      (await fixture.store.getProject(fixture.project.id))?.policy.verification.commands;
    const notice = async () => (await host.getState()).notice?.text;
    await app.submitForTest("/checks clear");
    await app.submitForTest("/checks add npm test -- --run");
    await app.submitForTest("/checks add npm run lint");
    expect(await saved()).toEqual(["npm test -- --run", "npm run lint"]);
    expect(await notice()).toBe("Checks:\n1. npm test -- --run\n2. npm run lint");
    await app.submitForTest("/checks remove 1");
    expect(await saved()).toEqual(["npm run lint"]);
    await app.submitForTest("/checks remove 5");
    expect(await notice()).toContain("There is no check 5.");
    await app.submitForTest("/checks drop");
    expect(await notice()).toBe(
      "Usage: /checks, /checks add <command>, /checks remove <number>, /checks clear or /checks mutation [on|off]",
    );
    expect(await saved()).toEqual(["npm run lint"]);
    await app.stop();
  });
});

describe("/websearch", () => {
  it("turns web search on only with Internet on, and off with it", async () => {
    const { app, host, fixture } = await appFixture();
    const network = async () =>
      (await fixture.store.getProject(fixture.project.id))?.policy.network;
    const notice = async () => (await host.getState()).notice?.text;
    await app.submitForTest("/network none");
    await app.submitForTest("/websearch on");
    expect(await notice()).toBe(
      "Web search needs Internet on: /network internet or /network both first.",
    );
    expect((await network())?.webSearch).toBe(false);
    await app.submitForTest("/network internet");
    await app.submitForTest("/websearch on");
    expect((await network())?.webSearch).toBe(true);
    expect(await notice()).toMatch(
      /^Web search for the manager and Planner: on\. No search engine/,
    );
    await app.submitForTest("/websearch engine http://127.0.0.1:8888");
    expect((await host.getState()).connection.webSearch?.url).toBe("http://127.0.0.1:8888");
    await app.submitForTest("/websearch");
    expect(await notice()).toBe(
      "Web search for the manager and Planner: on. Searches go through your search engine at http://127.0.0.1:8888.",
    );
    await app.submitForTest("/websearch engine none");
    expect((await host.getState()).connection.webSearch).toBeUndefined();
    await app.submitForTest("/network local");
    expect((await network())?.webSearch).toBe(false);
    await app.stop();
  });
});

describe("/fix-rounds", () => {
  it("sets this project's fix rounds, refuses out of range, and goes back to the default", async () => {
    const { app, host, fixture } = await appFixture();
    const rounds = async () =>
      (await fixture.store.getProject(fixture.project.id))?.policy.fixRoundsPerTask;
    const notice = async () => (await host.getState()).notice?.text;
    await app.submitForTest("/fix-rounds 4");
    expect(await rounds()).toBe(4);
    expect(await notice()).toBe("Fix rounds per task: 4.");
    await app.submitForTest("/fix-rounds 9");
    expect(await notice()).toBe("Usage: /fix-rounds [0-5|default]");
    expect(await rounds()).toBe(4);
    await app.submitForTest("/fix-rounds default");
    expect(await rounds()).toBeUndefined();
    expect(await notice()).toMatch(/^Fix rounds per task: \d \(the app default\)\.$/);
    await app.stop();
  });
});

describe("/permissions", () => {
  it("sets the app defaults, keeps a project's saved exact actions and refuses a bad mode", async () => {
    const { app, host, fixture } = await appFixture();
    const permissions = async () => (await host.getState()).permissions;
    const notice = async () => (await host.getState()).notice?.text;
    await app.submitForTest("/permissions default full");
    expect((await permissions()).defaultMode).toBe("full");
    expect(await notice()).toContain(`  ${fixture.project.name}: Full access (app default)`);
    await app.submitForTest("/permissions fix-rounds 3");
    expect((await permissions()).fixRoundsPerTask).toBe(3);
    await app.submitForTest("/permissions allow npm test -- --run");
    await app.submitForTest("/permissions allow-edit src/app.ts");
    const folder =
      fixture.project.source.kind === "local_folder" ? fixture.project.source.originalPath : "";
    expect((await permissions()).grants?.[fixture.project.id]).toEqual([
      { kind: "bash", action: "npm test -- --run", cwd: folder },
      { kind: "write", action: join(folder, "src/app.ts"), cwd: folder },
    ]);
    await app.submitForTest("/permissions forget 1");
    expect(await notice()).toBe(
      `Saved exact actions for this project:\n1. Edit ${join(folder, "src/app.ts")} (in ${folder})`,
    );
    await app.submitForTest("/permissions default sometimes");
    expect(await notice()).toMatch(/^Usage: \/permissions/);
    expect((await permissions()).defaultMode).toBe("full");
    await app.stop();
  });

  it("chooses and qualifies the approval reviewer by any name Poundlock serves", () => {
    const catalog = catalogFromProbe({
      interactiveModels: parseInteractiveModels([
        {
          id: "local-coder",
          poundlock: { profile_id: "stable-id", canonical_name: "local-coder" },
        },
      ]),
    });
    const context = {
      settings: { defaultMode: "assist" as const },
      projects: [],
      catalog,
      project: { id: "p", source: { kind: "local_folder" } } as unknown as ProjectRecord,
    };
    const chosen = permissionsCommand(context, "reviewer local-coder").settings;
    expect(chosen?.reviewer?.profileId).toBe("stable-id");
    const qualified = permissionsCommand({ ...context, settings: chosen! }, "qualify local-coder");
    expect(qualified.settings?.reviewer).toEqual({
      profileId: "stable-id",
      qualifiedProfileIds: ["stable-id"],
    });
    const automatic = permissionsCommand(
      { ...context, settings: qualified.settings! },
      "reviewer auto",
    );
    expect(automatic.settings?.reviewer?.profileId).toBeUndefined();
    expect(() => permissionsCommand(context, "reviewer nobody")).toThrow(/No profile named nobody/);
  });
});

describe("/local-manager", () => {
  it("tests a model server on this computer with a hidden token, then saves it; off keeps the model", async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ id: "qwen-local", context_length: 65536, max_output_tokens: 4096 }],
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { app, host, fixture, tui } = await appFixture();
      const saved = async () => (await fixture.store.getConnection()).localManager;
      const done = app.submitForTest(`/local-manager on qwen-local ${address} --output 2048`);
      await vi.waitFor(() => expect(tui.lastOverlay()).toBeDefined());
      const prompt = tui.lastOverlay()!.component as { handleInput(data: string): void };
      for (const char of "s3cret\r") prompt.handleInput(char);
      await done;
      expect(seen).toEqual(["Bearer s3cret"]);
      expect(await saved()).toEqual({
        enabled: true,
        url: address,
        token: "s3cret",
        model: "qwen-local",
        contextTokens: 65536,
        maxOutputTokens: 2048,
      });
      await app.submitForTest("/local-manager off");
      expect(await saved()).toMatchObject({ enabled: false, model: "qwen-local", token: "s3cret" });
      const missing = app.submitForTest(`/local-manager on other-model ${address}`);
      await vi.waitFor(() => expect(tui.lastOverlay()?.hidden).toBe(false));
      (tui.lastOverlay()!.component as { handleInput(data: string): void }).handleInput("\r");
      await missing;
      expect((await host.getState()).notice?.text).toMatch(/did not list the model “other-model”/);
      expect((await saved())?.enabled).toBe(false);
      await app.stop();
    } finally {
      server.close();
    }
  });
});

describe("/accounts", () => {
  it("saves a GitHub account with a hidden token, refuses a Gitea one without a token, and removes", async () => {
    const { app, host, tui } = await appFixture();
    const integrations = async () => (await host.getState()).integrations;
    const notice = async () => (await host.getState()).notice?.text;
    const answer = async (submitted: Promise<void>, typed: string) => {
      await vi.waitFor(() => expect(tui.lastOverlay()?.hidden).toBe(false));
      const prompt = tui.lastOverlay()!.component as { handleInput(data: string): void };
      for (const char of `${typed}\r`) prompt.handleInput(char);
      await submitted;
    };
    await answer(app.submitForTest("/accounts github octo"), "test-token");
    expect((await integrations()).github).toEqual({
      configured: true,
      host: "https://github.com",
      username: "octo",
    });
    expect(JSON.stringify(await host.getState())).not.toContain("test-token");
    await app.submitForTest("/accounts gitea me");
    expect(await notice()).toBe(
      "Give the Gitea base address: /accounts gitea <username> <address>.",
    );
    await answer(app.submitForTest("/accounts gitea me https://gitea.example.net"), "");
    expect(await notice()).toBe("Paste a Gitea access token.");
    await app.submitForTest("/accounts");
    expect(await notice()).toBe("GitHub: octo at https://github.com.\nGitea: not configured.");
    await app.submitForTest("/accounts remove github");
    expect((await integrations()).github).toBeUndefined();
    await app.stop();
  });
});

describe("/runtime and /repo-account", () => {
  it("chooses and clears the project's Node, and keeps repository access public without a remote", async () => {
    const { app, host, fixture } = await appFixture();
    const notice = async () => (await host.getState()).notice?.text;
    const bin = await tempDir("tui-node-");
    await writeFile(join(bin, "node"), "#!/bin/sh\n", { mode: 0o755 });
    await app.submitForTest(`/runtime node ${bin}`);
    const chosen = await realpath(bin);
    expect((await fixture.store.getProject(fixture.project.id))?.policy.runtimes?.node).toBe(
      chosen,
    );
    await app.submitForTest("/runtime");
    expect(await notice()).toContain(`Node runtime: ${chosen}.`);
    await app.submitForTest("/runtime node 99");
    expect(await notice()).toMatch(/^There is no detected Node 99/);
    await app.submitForTest("/runtime node none");
    expect((await fixture.store.getProject(fixture.project.id))?.policy.runtimes).toBeUndefined();
    await app.submitForTest("/repo-account github");
    expect(await notice()).toMatch(/no git remote/);
    await app.submitForTest("/repo-account");
    expect(await notice()).toBe("Repository access: public clone only.");
    await app.stop();
  });
});

describe("/checks mutation", () => {
  it("turns the mutation check off and back on", async () => {
    const { app, host, fixture } = await appFixture();
    const mutation = async () =>
      (await fixture.store.getProject(fixture.project.id))?.policy.mutationCheck;
    await app.submitForTest("/checks mutation off");
    expect(await mutation()).toBe(false);
    expect((await host.getState()).notice?.text).toBe("Mutation check: off.");
    await app.submitForTest("/checks mutation on");
    expect(await mutation()).toBeUndefined();
    expect((await host.getState()).notice?.text).toMatch(/^Mutation check: on\./);
    await app.stop();
  });
});

describe("/grant-file", () => {
  it("lets the manager read one excluded file, lists it in setup, and takes it back", async () => {
    const { app, host, fixture } = await appFixture();
    await writeFile(join(fixture.folder, ".env"), "TOKEN=x\n");
    const grants = async () =>
      (await fixture.store.getProject(fixture.project.id))?.policy.readGrants ?? [];
    await app.submitForTest("/grant-file .env");
    const real = await realpath(join(fixture.folder, ".env"));
    expect(await grants()).toEqual([real]);
    await app.submitForTest("/setup");
    expect(app.renderForTest(200).map(stripTerminalSequences).join("\n")).toContain(real);
    await app.submitForTest("/revoke-file .env");
    expect(await grants()).toEqual([]);
    await app.submitForTest("/revoke-file .env");
    expect((await host.getState()).notice?.text).toContain("is not a read exception.");
    await app.stop();
  });
});
