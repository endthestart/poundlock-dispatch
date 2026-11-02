/**
 * The terminal screens, asserted as data.
 *
 * These run with no terminal and no pi-tui, which is the point: what the user
 * is shown is decided by pure functions over the same `AppStateView` the
 * desktop app renders, so the two front ends cannot disagree about what a
 * project is doing.
 */
import type { ToolApproval } from "@shared/permissions";
import { projectStatusView } from "@shared/project-status";
import type { AppStateView, ChatMessage, ProjectRecord, ProjectSnapshot } from "@shared/types";
import { defaultPolicy } from "@shared/types";
import {
  renderActions,
  renderBoard,
  renderComposerHint,
  renderConversation,
  renderSetup,
  renderStatusLines,
  renderTranscript,
} from "@tui/render";
import { describe, expect, it } from "vitest";

const WIDTH = 80;

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "demo",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: "/tmp/demo",
      baseRevision: "",
      excludedPatterns: [],
    },
    policy: defaultPolicy(),
    budget: { jobsSubmitted: 0, managerTurnsUsed: 0, externalEscalationsUsed: 0 },
    integration: {},
    planRevision: 1,
    managerSessionId: "session-1",
    ...overrides,
  } as ProjectRecord;
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return { project: project(), tasks: [], messages: [], ...overrides };
}

function state(overrides: Partial<AppStateView> = {}): AppStateView {
  return {
    connection: {
      url: "https://poundlock.example",
      tokenConfigured: true,
      roles: {},
      rolesReady: true,
    },
    integrations: {},
    permissions: { defaultMode: "ask" },
    ui: { composerInfolets: [], desktopNotifications: false } as AppStateView["ui"],
    appearance: { theme: "system" },
    projects: [project()],
    selectedProjectId: "proj-1",
    snapshot: snapshot(),
    busy: false,
    ...overrides,
  } as AppStateView;
}

function approval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    id: "appr-1",
    projectId: "proj-1",
    projectName: "demo",
    planRevision: 1,
    kind: "bash",
    action: "npm test",
    reason: "run the test suite",
    cwd: "/tmp/demo",
    ...overrides,
  };
}

const text = (lines: string[]) => lines.join("\n");

describe("conversation screen", () => {
  it("tells the user to open a folder when nothing is attached", () => {
    const screen = renderConversation(state({ snapshot: undefined }), WIDTH);
    expect(text(screen.lines)).toMatch(/Open a folder to begin/);
  });

  it("shows the transcript with who said what", () => {
    const screen = renderConversation(
      state({
        snapshot: snapshot({
          messages: [
            { id: "1", role: "user", text: "add a health endpoint", createdAt: "" },
            { id: "2", role: "manager", text: "Here is the plan.", createdAt: "" },
          ],
        }),
      }),
      WIDTH,
    );
    // Both turns are present; which is which is shown by where they sit, not
    // by a word in a gutter. See "telling your words from the manager's".
    expect(text(screen.lines)).toMatch(/\u258F add a health endpoint/);
    expect(text(screen.lines)).toMatch(/^Here is the plan\.$/m);
  });

  it("replaces everything else with the decision when one is pending", () => {
    const screen = renderConversation(
      state({
        approvals: [approval()],
        snapshot: snapshot({
          messages: [{ id: "1", role: "user", text: "build it", createdAt: "" }],
          plan: {
            summary: "A plan nobody can approve yet",
            acceptanceCriteria: ["works"],
            approved: false,
          } as ProjectSnapshot["plan"],
        }),
      }),
      WIDTH,
    );
    const body = text(screen.lines);
    expect(body).toMatch(/decision needed/);
    expect(body).toMatch(/npm test/);
    // The plan must not compete with the decision for the user's attention.
    expect(body).not.toMatch(/A plan nobody can approve yet/);
  });

  it("will not let the composer send while a decision is waiting", () => {
    const screen = renderConversation(state({ approvals: [approval()] }), WIDTH);
    // Exactly the rule the desktop composer uses, not a second opinion.
    expect(screen.hint).toMatch(/Decide the approval card before sending/);
  });

  it("offers approve as the action on a proposed plan", () => {
    const screen = renderConversation(
      state({
        snapshot: snapshot({
          project: project({ status: "awaiting_approval" }),
          plan: {
            summary: "Add a health endpoint",
            acceptanceCriteria: ["GET /health returns 200"],
            approved: false,
          } as ProjectSnapshot["plan"],
        }),
      }),
      WIDTH,
    );
    const body = text(screen.lines);
    expect(body).toMatch(/proposed plan/);
    expect(body).toMatch(/GET \/health returns 200/);
    expect(body).toMatch(/\/approve to start/);
  });

  it("numbers the manager's choices so one keystroke answers", () => {
    const screen = renderConversation(
      state({
        snapshot: snapshot({
          project: project({
            status: "needs_input",
            needsInput: {
              question: "Single user or multi user?",
              askedAt: "",
              choices: [
                { id: "single", label: "Single user" },
                { id: "multi", label: "Multi user" },
              ],
            },
          }),
        }),
      }),
      WIDTH,
    );
    const body = text(screen.lines);
    expect(body).toMatch(/Single user or multi user\?/);
    expect(body).toMatch(/\[1\] Single user/);
    expect(body).toMatch(/\[2\] Multi user/);
  });

  it("surfaces an error notice rather than hiding it", () => {
    const screen = renderConversation(
      state({ notice: { kind: "error", text: "The desktop app is driving this folder." } }),
      WIDTH,
    );
    expect(text(screen.lines)).toMatch(/! The desktop app is driving this folder\./);
  });

  it("says what is happening while work runs, where it cannot scroll away", () => {
    // Pinned above the composer rather than appended to the transcript: the
    // moment the conversation grew past a screen, the run's own state — and
    // the budget, the reason to watch a frontier model at all — scrolled off.
    const [activity] = renderStatusLines(
      state({ busy: true, activity: "gpt-oss-120b is replying…" }),
      WIDTH,
    );
    expect(activity).toMatch(/gpt-oss-120b is replying/);
    expect(activity).not.toContain("\n");

    // And the body no longer repeats it.
    const screen = renderConversation(
      state({ busy: true, activity: "gpt-oss-120b is replying…" }),
      WIDTH,
    );
    expect(text(screen.lines)).not.toMatch(/gpt-oss-120b is replying/);
  });

  it("keeps the budget while the models and the budget can share a line", () => {
    // Choosing a frontier model is the one case where spend matters, and it is
    // also what makes the line long: two model names arrive and the number
    // must not be the thing that goes while there is room for it.
    const withBudget = state({
      connection: {
        url: "https://poundlock.example",
        tokenConfigured: true,
        rolesReady: true,
        roles: {
          manager: { profileId: "f", profileName: "frontier-gpt-sol", source: "interactive" },
          interactive: { profileId: "c", profileName: "orion-fast", source: "interactive" },
        },
      } as AppStateView["connection"],
      ui: { composerInfolets: ["budget"], desktopNotifications: false } as AppStateView["ui"],
      probe: {
        ok: true,
        managedIdentities: [
          { usage_status: "available", usage: { remaining_budget: 4.12, spend: 0.88 } },
        ],
      } as unknown as AppStateView["probe"],
    });

    for (const width of [120, 100, 80, 60]) {
      const [, models] = renderStatusLines(withBudget, width);
      expect(models, `width ${width}`).toContain("$4.12");
      expect(models.length, `width ${width}`).toBeLessThanOrEqual(width);
    }

    // And it still reads in a sensible order when everything fits: who is
    // driving, what with, then what it costs.
    const [, full] = renderStatusLines(withBudget, 120);
    expect(full.indexOf("mgr ")).toBeLessThan(full.indexOf("wrk "));
    expect(full.indexOf("wrk ")).toBeLessThan(full.indexOf("$4.12"));
  });

  it("keeps the models in view, and stays one line whatever it holds", () => {
    // Which models are driving matters most when they are not the local ones
    // — a frontier manager is the case this line exists for.
    const [, models] = renderStatusLines(
      state({
        connection: {
          url: "https://poundlock.example",
          tokenConfigured: true,
          rolesReady: true,
          roles: {
            manager: {
              profileId: "frontier-id",
              profileName: "frontier-gpt-sol",
              source: "interactive",
            },
            interactive: {
              profileId: "orion-id",
              profileName: "orion-fast",
              source: "interactive",
            },
          },
        } as AppStateView["connection"],
      }),
      WIDTH,
    );
    expect(models).toContain("mgr frontier-gpt-sol");
    expect(models).toContain("wrk orion-fast");
    expect(models).not.toContain("\n");
    expect(models.length).toBeLessThanOrEqual(WIDTH);
  });

  it("names this project's own worker, as its runs use it", () => {
    const own = project({ policy: { ...defaultPolicy(), workerModel: "69dc56fd" } });
    const [, models] = renderStatusLines(
      state({
        snapshot: snapshot({ project: own }),
        connection: {
          url: "https://poundlock.example",
          tokenConfigured: true,
          rolesReady: true,
          roles: {
            interactive: {
              profileId: "frontier-id",
              profileName: "frontier-gpt-sol",
              source: "interactive",
            },
          },
        } as AppStateView["connection"],
        probe: {
          ok: true,
          interactiveModels: [{ id: "vega-qwen", profileId: "69dc56fd" }],
        } as AppStateView["probe"],
      }),
      WIDTH,
    );
    expect(models).toContain("wrk vega-qwen");
    expect(models).not.toContain("frontier-gpt-sol");
  });

  it("wraps long text to the terminal width", () => {
    const long = "word ".repeat(200).trim();
    const screen = renderConversation(
      state({
        snapshot: snapshot({ messages: [{ id: "1", role: "manager", text: long, createdAt: "" }] }),
      }),
      WIDTH,
    );
    for (const line of screen.lines) expect(line.length).toBeLessThanOrEqual(WIDTH);
  });
});

describe("the two-line status", () => {
  const withRoles = state({
    connection: {
      url: "https://poundlock.example",
      tokenConfigured: true,
      rolesReady: true,
      roles: {
        manager: { profileId: "f", profileName: "frontier-gpt-sol", source: "interactive" },
        interactive: { profileId: "c", profileName: "orion-fast", source: "interactive" },
      },
    } as AppStateView["connection"],
    ui: { composerInfolets: ["budget"], desktopNotifications: false } as AppStateView["ui"],
    probe: {
      ok: true,
      managedIdentities: [
        { usage_status: "available", usage: { remaining_budget: 4.12, spend: 0.88 } },
      ],
    } as unknown as AppStateView["probe"],
    busy: true,
    activity: "gpt-oss-120b is replying…",
  });

  it("never wraps, whatever the width", () => {
    for (const width of [40, 80, 200]) {
      const [line1, line2] = renderStatusLines(withRoles, width);
      expect(line1).not.toContain("\n");
      expect(line2).not.toContain("\n");
      expect(line1.length).toBeLessThanOrEqual(width);
      expect(line2.length).toBeLessThanOrEqual(width);
    }
  });

  it("puts what is moving on line 1, the manager and worker on line 2", () => {
    // The project and its state are in the title bar above, not repeated here.
    const [line1, line2] = renderStatusLines(withRoles, 200);
    expect(line1).toContain("gpt-oss-120b is replying");
    expect(line1).not.toContain("demo");
    expect(line2).toContain("mgr frontier-gpt-sol");
    expect(line2).toContain("wrk orion-fast");
    expect(line2).toContain("$4.12");
  });

  it("keeps the manager in view over the worker and the budget at 40 columns", () => {
    const [, line2] = renderStatusLines(withRoles, 40);
    expect(line2).toContain("mgr frontier-gpt-sol");
  });

  it("names the local fallback once a spending limit moved the manager to it", () => {
    const onFallback = {
      ...withRoles,
      snapshot: snapshot({
        project: project({
          managerFallback: {
            profileId: "orion",
            profileName: "orion-qwen",
            from: "frontier-gpt-sol",
            at: "2026-10-28T10:00:00.000Z",
          },
        }),
      }),
    };
    const [, line2] = renderStatusLines(onFallback, 200);
    expect(line2).toContain("mgr orion-qwen (local fallback after a spending limit)");
    expect(line2).not.toContain("frontier-gpt-sol");
  });
});

describe("board screen", () => {
  it("shows each task's state in words, not just a symbol", () => {
    const screen = renderBoard(
      state({
        snapshot: snapshot({
          tasks: [
            {
              id: "t1",
              title: "Add the endpoint",
              status: "applied",
              route: "interactive",
              attempts: [],
            },
            { id: "t2", title: "Add tests", status: "running", route: "durable", attempts: [] },
          ] as unknown as ProjectSnapshot["tasks"],
        }),
      }),
      WIDTH,
    );
    const body = text(screen.lines);
    expect(body).toMatch(/\[x\] 1\. Add the endpoint\n {4}Accepted/);
    expect(body).toMatch(/\[>\] 2\. Add tests\n {4}Running/);
  });

  it("says so plainly when there is nothing to show yet", () => {
    expect(text(renderBoard(state(), WIDTH).lines)).toMatch(/No tasks yet/);
  });

  it("shows the project brief the manager keeps pinned, and nothing when there is none", () => {
    const withBrief = text(
      renderBoard(
        state({ snapshot: snapshot({ brief: "Objective: slugs.\nADRs: docs/adr/001-slugs.md" }) }),
        WIDTH,
      ).lines,
    );
    // A section like the plan's and the tasks': a heading over a rule, then the text.
    expect(withBrief).toMatch(
      /Project brief\n\u2500+\nObjective: slugs\.\nADRs: docs\/adr\/001-slugs\.md/,
    );
    expect(text(renderBoard(state({ snapshot: snapshot() }), WIDTH).lines)).not.toMatch(
      /Project brief/,
    );
  });
});

describe("setup screen", () => {
  it("reports what is configured and what is missing", () => {
    const screen = renderSetup(
      state({
        connection: { url: "", tokenConfigured: false, roles: {}, rolesReady: false },
      }),
      WIDTH,
    );
    const body = text(screen.lines);
    expect(body).toMatch(/Controller\s+\(not set\)/);
    expect(body).toMatch(/Token\s+\(not set\)/);
    expect(body).toMatch(/Roles ready\s+no/);
  });

  it("says settings are shared once the machine is configured", () => {
    expect(text(renderSetup(state(), WIDTH).lines)).toMatch(/shared with the desktop app/);
  });
});

describe("telling your words from the manager's", () => {
  const message = (role: string, text: string) =>
    ({ id: role, role, text, createdAt: "2026-01-01T00:00:00Z" }) as ChatMessage;

  it("sets your own messages against the right margin", () => {
    // Every line used to carry an eight-column speaker gutter — the word
    // once, then eight spaces on every wrapped line — which spent a tenth of
    // the terminal restating whose turn it was.
    // Only the time sits over it, against the same margin.
    const lines = renderTranscript([message("user", "Give me a quick summary.")], WIDTH);
    const written = lines.filter((line) => line.trim());
    expect(written).toHaveLength(2);
    expect(written[0]).toMatch(/^ +\S.*20\d\d/);
    expect(written[1]).toMatch(/^ +\u258F /);
    expect(written[1].length).toBeLessThanOrEqual(WIDTH);
    expect(written.join("\n")).not.toMatch(/you/i);
  });

  it("leaves the manager flush left and unlabelled", () => {
    // The manager is the default voice here; labelling it spends a column on
    // saying so. Machinery still marks itself, because it is not a voice.
    // Only its time sits over it.
    const lines = renderTranscript([message("manager", "Here is the summary.")], WIDTH);
    expect(lines[1]).toBe("Here is the summary.");
    expect(lines.slice(0, 2).join("\n")).not.toMatch(/manager/i);

    const system = renderTranscript([message("system", "Plan approved.")], WIDTH);
    expect(system[0]).toBe("\u00b7 Plan approved.");
  });

  it("shows an investigation the same way as any other system message", () => {
    // The manager's `investigate` tool has no card of its own \u2014 it is a
    // read-only worker turn narrated in the transcript like any other system
    // event, so nothing here has to know about it by name.
    const starting = renderTranscript(
      [message("system", "Investigating with coding: why does CI fail?")],
      WIDTH,
    );
    expect(starting[0]).toBe("\u00b7 Investigating with coding: why does CI fail?");

    const finished = renderTranscript(
      [
        {
          id: "m1",
          role: "manager",
          text: "CI fails because the lockfile is stale.",
          createdAt: "",
          toolTrace: [{ name: "investigate", summary: "ok" }],
        } as ChatMessage,
      ],
      WIDTH,
    );
    expect(finished).toContain("\u00b7 investigate");
  });

  it("keeps a wrapped message of yours inside the terminal", () => {
    const long = "word ".repeat(60).trim();
    const lines = renderTranscript([message("user", long)], WIDTH)
      .filter((line) => line.trim())
      .slice(1);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(WIDTH);
      // Left-aligned within the block: the edge you read from stays straight.
      expect(line).toMatch(/^ +\u258F /);
    }
    const indents = new Set(lines.map((line) => line.length - line.trimStart().length));
    expect(indents.size).toBe(1);
  });
});

describe("what the actions line is for", () => {
  it("does not restate the composer's own prompt", () => {
    // This produced "type a message Message the manager" — two halves of one
    // idea run together, directly above a hint saying the same thing.
    expect(renderActions([{ id: "send_message", label: "Message the manager" }])).toEqual([]);
    expect(renderActions([{ id: "reply", label: "Reply" }])).toEqual([]);
    expect(renderActions([{ id: "choose", label: "Choose one" }])).toEqual([]);
  });

  it("names the actions that are invoked by a command", () => {
    expect(renderActions([{ id: "approve", label: "Approve the plan" }])).toEqual([
      "/approve  Approve the plan",
    ]);
  });

  it("reopens a review rather than resuming the run", () => {
    // review_again once pointed at /resume (startRun); the contract is reopenRun.
    expect(renderActions([{ id: "review_again", label: "Review again" }])).toEqual([
      "/reopen  Review again",
    ]);
  });
});

describe("the project's status while Autopilot runs it", () => {
  it("leaves how far along it is to the Autopilot card, as the app does", () => {
    const status = projectStatusView(snapshot());
    expect(status.evidence).toBeTruthy();
    const running = state({ autopilot: { phase: "running" } as AppStateView["autopilot"] });
    expect(renderStatusLines(state(), 100)[0]).toContain(status.evidence);
    expect(renderStatusLines(running, 100)[0]).not.toContain(status.evidence);
  });
});

describe("the composer while Autopilot holds the project", () => {
  it("says that what is typed goes to the run, and when the run reads it", () => {
    const hint = (phase: string) =>
      renderComposerHint(state({ autopilot: { phase } as AppStateView["autopilot"] }));
    expect(hint("running")).toMatch(/^Message Autopilot: the worker hears it now/);
    expect(hint("interrupted")).toBe("Message Autopilot: the run reads it when you resume…");
    expect(hint("ended")).not.toContain("Message Autopilot");
  });
});
