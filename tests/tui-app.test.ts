/**
 * Keys and commands, driven with a stub terminal.
 *
 * The risk here is not painting — it is a keystroke meaning the wrong thing.
 * A letter typed inside a sentence must never answer a decision, and a pending
 * decision must own the keyboard exactly as it blocks the composer.
 */

import { ApprovalBroker } from "@core/approval-broker";
import { DispatchHost, type HostDependencies } from "@core/host/dispatch-host";
import {
  type ManagerCompactContext,
  type ManagerPort,
  ProjectOrchestrator,
} from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import type { SelectList } from "@earendil-works/pi-tui";
import {
  matchesKey,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { hostCommandPort } from "@runtime/host-command";
import { SEARCH_KEYS, TuiApp } from "@tui/app";
import { Card } from "@tui/card";
import { CONTROL_COMMANDS } from "@tui/render";
import { describe, expect, it, vi } from "vitest";
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

async function appFixture(options: { manager?: ManagerPort } = {}) {
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
  const tui = stubTui();
  const exit = vi.fn();
  // The stub implements only the TUI surface the app actually calls.
  const app = new TuiApp(host, tui as unknown as ConstructorParameters<typeof TuiApp>[1], exit);
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
    });
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
    expect(notice?.text).toContain("external");
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
