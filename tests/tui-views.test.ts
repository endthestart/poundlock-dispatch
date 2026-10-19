/**
 * The terminal's screens at real widths.
 *
 * `tui-render.test.ts` checks what each screen says. This checks how it is
 * laid out: that nothing is wider than the terminal at 80, 100 and 120
 * columns, that colour is only ever decoration over the same text, and that
 * the title bar, the banner, the board and the setup read the way the desktop
 * app's equivalents do.
 */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { projectStatusView } from "@shared/project-status";
import type { AppStateView, ProjectSnapshot, TaskStatus } from "@shared/types";
import { createColours, PLAIN } from "@tui/colour";
import {
  approvalCardParts,
  planCardBody,
  renderBanner,
  renderBoard,
  renderNotices,
  renderSetup,
  renderStatusLines,
  renderTitleBar,
} from "@tui/render";
import { describe, expect, it } from "vitest";
import {
  approval,
  attempt,
  finishedAttempt,
  message,
  project,
  ROLES,
  snapshot,
  state,
  task,
} from "./support/tui-fixtures";

const WIDTHS = [60, 80, 100, 120];
const colour = createColours({ theme: "mocha", isTTY: true, env: { COLORTERM: "truecolor" } });
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
const fits = (lines: string[], width: number) => lines.every((line) => visibleWidth(line) <= width);

const CONNECTED = {
  url: "https://poundlock.example:8443",
  tokenConfigured: true,
  rolesReady: true,
  roles: ROLES,
} as unknown as AppStateView["connection"];

function running(overrides: Partial<AppStateView> = {}): AppStateView {
  return state({
    connection: CONNECTED,
    snapshot: snapshot({
      project: project({ status: "running" }),
      plan: {
        revision: 2,
        summary: "Add a tokenizer module and cover it with tests.",
        acceptanceCriteria: ["split() ignores empty strings", "npm test passes"],
        authority: "Edit project files",
        approved: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      tasks: [
        task("Add the tokenizer module", "applied", { attempts: [finishedAttempt()] }),
        task("Write tokenizer unit tests", "running", { attempts: [attempt(1)] }),
        task("Wire the tokenizer into the command line entry point", "ready", { route: "snippet" }),
      ],
    }),
    busy: true,
    activity: "Qwen3 Coder 30B is working on “Write tokenizer unit tests”…",
    ...overrides,
  });
}

describe("the title bar", () => {
  it("names the project, its state in words, and where Poundlock is", () => {
    const [bar, underline] = plain(renderTitleBar(running(), 100));
    expect(bar).toMatch(/^ {2}demo {2}● Work in progress/);
    expect(bar).toContain("poundlock.example:8443");
    // The connection sits at the right edge, inside the same margin as the left.
    expect(visibleWidth(bar)).toBe(98);
    expect(underline).toBe("─".repeat(100));
  });

  it("is two lines, both inside the terminal, at every width", () => {
    for (const width of [40, ...WIDTHS]) {
      const lines = renderTitleBar(running(), width, colour);
      expect(lines, `${width}`).toHaveLength(2);
      expect(fits(lines, width), `${width}`).toBe(true);
    }
  });

  it("says when Poundlock is not connected, or cannot be reached", () => {
    const unset = state({
      connection: { url: "", tokenConfigured: false, roles: {}, rolesReady: false },
      probe: undefined,
    });
    expect(plain(renderTitleBar(unset, 100))[0]).toContain("○ not connected");

    const down = running({ probe: { ok: false, error: "refused" } as AppStateView["probe"] });
    expect(plain(renderTitleBar(down, 100))[0]).toContain("○ unreachable · poundlock.example:8443");
  });

  it("keeps a problem visible when the line is too narrow for the whole phrase", () => {
    const down = running({ probe: { ok: false, error: "refused" } as AppStateView["probe"] });
    const [bar] = plain(renderTitleBar(down, 46));
    expect(bar).toContain("○ unreachable");
    expect(visibleWidth(bar)).toBeLessThanOrEqual(46);
  });

  it("paints the state in the desktop app's tone for it", () => {
    const [active] = renderTitleBar(running(), 100, colour);
    expect(active).toContain(colour.paint("active", "● Work in progress"));

    const done = state({
      connection: CONNECTED,
      snapshot: snapshot({ project: project({ status: "completed" }) }),
    });
    expect(renderTitleBar(done, 100, colour)[0]).toContain(colour.paint("ok", "● Work completed"));

    const failed = state({
      connection: CONNECTED,
      snapshot: snapshot({ project: project({ status: "failed" }) }),
    });
    expect(renderTitleBar(failed, 100, colour)[0]).toContain(
      colour.paint("fault", "● Work stopped"),
    );
  });

  it("marks a run that is waiting on you as needing you, though the project says running", () => {
    const waiting = running({ approvals: [approval()] });
    const [bar] = renderTitleBar(waiting, 100, colour);
    expect(bar).toContain(colour.paint("review", "● Approval needed"));
  });

  it("says whose it is when there is no project", () => {
    const none = state({ snapshot: undefined, selectedProjectId: undefined });
    expect(plain(renderTitleBar(none, 80))[0]).toContain("Poundlock Dispatch");
  });
});

describe("the status lines", () => {
  it("shows a spinner frame beside what is running, and none when it is idle", () => {
    const [busy] = plain([renderStatusLines(running(), 100, colour, "⠹")[0]]);
    expect(busy).toContain("⠹ Qwen3 Coder 30B is working");
    const idle = running({ busy: false, activity: undefined });
    expect(renderStatusLines(idle, 100, colour, undefined)[0]).not.toContain("⠹");
  });

  it("shows how far along the plan is, at the right when there is room", () => {
    const [one] = plain([renderStatusLines(running(), 140, colour)[0]]);
    expect(one).toContain("1 of 3 tasks accepted");
    expect(one.trimEnd().endsWith("started.")).toBe(true);
    const idle = running({ busy: false, activity: undefined });
    expect(renderStatusLines(idle, 100)[0]).toContain("1 of 3 tasks accepted");
  });

  it("keeps the progress on the line beside a long activity, at every width it fits", () => {
    // It once went first when the activity was long, so a running screen at
    // 100 columns said nothing about how far along the plan was.
    for (const width of [60, 80, 100, 120]) {
      const inner = width - 4;
      const [one] = renderStatusLines(running(), inner, PLAIN, "⠹");
      expect(one, `${width}`).toContain("1 of 3 tasks accepted");
      expect(one, `${width}`).toContain("Qwen3 Coder 30B is working");
      expect(visibleWidth(one), `${width}`).toBeLessThanOrEqual(inner);
    }
  });

  it("gives its first sentence when the whole of it will not fit, and cuts the activity before it", () => {
    const [medium] = renderStatusLines(running(), 96, PLAIN, "⠹");
    expect(medium).toMatch(/1 of 3 tasks accepted$/);
    expect(medium).not.toContain("Task 2 of 3 started");
    const [narrow] = renderStatusLines(running(), 56, PLAIN, "⠹");
    expect(narrow).toMatch(/…\s+1 of 3 tasks accepted$/);
  });

  it("drops the progress, not the activity, only when the line is too narrow for both", () => {
    const [tiny] = renderStatusLines(running(), 30, PLAIN, "⠹");
    expect(tiny).toContain("Qwen3 Coder");
    expect(tiny).not.toContain("tasks accepted");
  });

  it("leaves the progress out on request, for a screen that shows it itself", () => {
    const idle = running({ busy: false, activity: undefined });
    expect(renderStatusLines(idle, 100, PLAIN, undefined, false)[0]).toBe("");
  });

  it("never runs past the terminal, with or without colour", () => {
    for (const width of [30, ...WIDTHS])
      for (const colours of [PLAIN, colour]) {
        const [one, two] = renderStatusLines(running(), width, colours, "⠹");
        expect(visibleWidth(one), `${width}`).toBeLessThanOrEqual(width);
        expect(visibleWidth(two), `${width}`).toBeLessThanOrEqual(width);
      }
  });
});

describe("the banner", () => {
  const status = (s: AppStateView) => projectStatusView(s.snapshot!, { approvals: s.approvals });

  it("says so, in the review colour, when Poundlock is not connected", () => {
    const unset = state({
      connection: { url: "", tokenConfigured: false, roles: {}, rolesReady: false },
    });
    const lines = renderBanner(unset, status(unset), 100, colour);
    expect(plain(lines)[0]).toMatch(/^Not connected to Poundlock\. Run \/connect/);
    expect(lines[0]).toContain(colour.paint("review", ""));
  });

  it("explains an unreachable controller, unless a failed command has just said the same", () => {
    const error = "connect ECONNREFUSED 10.20.0.12:8443";
    const down = running({ probe: { ok: false, error } as AppStateView["probe"] });
    expect(plain(renderBanner(down, status(down), 100)).join(" ")).toContain(
      `Poundlock is not reachable: ${error}`,
    );
    const said = running({
      probe: { ok: false, error } as AppStateView["probe"],
      notice: { kind: "error", text: `Poundlock is not reachable: ${error}` },
    });
    expect(renderBanner(said, status(said), 100).join(" ")).not.toContain("not reachable");
  });

  it("tells an empty conversation how to begin", () => {
    const empty = state({ connection: CONNECTED });
    const text = plain(renderBanner(empty, status(empty), 100)).join("\n");
    expect(text).toContain("Describe what you want built");
    for (const command of ["/setup", "/board", "/trust"]) expect(text).toContain(command);
  });

  it("does not tell a conversation that has started how to begin", () => {
    const started = running();
    started.snapshot!.messages = [message("user", "add a tokenizer")];
    expect(renderBanner(started, status(started), 100).join("\n")).not.toContain("Useful commands");
  });

  it("leaves what the run wants next to the card that is already asking for it", () => {
    const proposed = state({
      connection: CONNECTED,
      snapshot: snapshot({
        project: project({ status: "awaiting_approval" }),
        plan: {
          revision: 1,
          summary: "Add a tokenizer",
          acceptanceCriteria: [],
          authority: "",
          approved: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    expect(status(proposed).next).toBeTruthy();
    expect(renderBanner(proposed, status(proposed), 100).join("\n")).not.toContain(
      status(proposed).next,
    );
  });
});

describe("the notices", () => {
  it("marks an error with ! in the fault colour, and news with · in the accent", () => {
    const failed = state({ notice: { kind: "error", text: "The folder is locked." } });
    expect(renderNotices(failed, 80)).toEqual(["! The folder is locked."]);
    expect(renderNotices(failed, 80, colour)[0]).toBe(
      colour.paint("fault", "! The folder is locked."),
    );

    const news = state({ notice: { kind: "info", text: "Connected to Poundlock 0.9.4." } });
    expect(renderNotices(news, 80)).toEqual(["· Connected to Poundlock 0.9.4."]);
    expect(renderNotices(news, 80, colour)[0]).toContain(colour.paint("accent", "· "));
  });

  it("keeps a multi-line notice's lines apart, and wraps each to the width", () => {
    const models = state({
      notice: {
        kind: "info",
        text: [
          "Model profiles Poundlock is serving:",
          "  one   two",
          "",
          "A long closing line ".repeat(6),
        ].join("\n"),
      },
    });
    for (const width of [40, 80]) {
      const lines = renderNotices(models, width);
      expect(fits(lines, width), `${width}`).toBe(true);
      expect(lines[0]).toBe("· Model profiles Poundlock is serving:");
      expect(lines.length).toBeGreaterThan(4);
    }
  });

  it("keeps the columns of a notice that is a table", () => {
    const table = state({
      notice: {
        kind: "info",
        text: `Model profiles Poundlock is serving:\n  ${"alpha".padEnd(12)}${"interactive".padEnd(14)}manager`,
      },
    });
    const [, row] = renderNotices(table, 80);
    // Two columns for the mark's hanging indent, then the row exactly as written.
    expect(row).toBe(`    ${"alpha".padEnd(12)}${"interactive".padEnd(14)}manager`);
  });

  it("names what recovery is waiting on", () => {
    const recovering = state({
      recovery: [
        {
          kind: "route_change",
          title: "The route changed",
          detail: "",
          nextAction: "Run /approve-models.",
        },
      ],
    });
    expect(renderNotices(recovering, 80)).toEqual(["· The route changed — Run /approve-models."]);
  });
});

describe("the board", () => {
  it("reads like the desktop's Plan and Tasks: revision and approval, criteria, progress", () => {
    const text = renderBoard(running(), 100).lines.join("\n");
    expect(text).toMatch(/^Plan +Revision 2 · Approved\n─+\n/);
    expect(text).toContain("Add a tokenizer module and cover it with tests.");
    expect(text).toContain(
      "Acceptance criteria\n  • split() ignores empty strings\n  • npm test passes",
    );
    expect(text).toMatch(/Tasks\n─+\n1 of 3 tasks accepted\. Task 2 of 3 started\./);
  });

  it("says a plan Dispatch approved itself was approved automatically, and under what", () => {
    const auto = running();
    auto.snapshot!.plan = { ...auto.snapshot!.plan!, autoApprovedUnder: "full" };
    expect(renderBoard(auto, 100).lines[0]).toContain("Approved automatically (Full access)");
  });

  it("marks each task by state and says the state in words, in the state's tone", () => {
    const { lines } = renderBoard(running(), 100, colour);
    const body = plain(lines).join("\n");
    expect(body).toContain("[x] Add the tokenizer module\n    Accepted · interactive");
    expect(body).toContain(
      "[>] Write tokenizer unit tests\n    Running · interactive · Qwen3 Coder 30B",
    );
    expect(body).toContain(
      "[ ] Wire the tokenizer into the command line entry point\n    Up next · snippet",
    );
    const raw = lines.join("\n");
    expect(raw).toContain(colour.paint("ok", "[x]"));
    expect(raw).toContain(colour.paint("active", "[>]"));
    expect(raw).toContain(colour.paint("review", "[ ]"));
    expect(raw).toContain(colour.paint("active", "Running"));
  });

  it("uses one plain ASCII mark for every state a task can be in", () => {
    // ASCII, so no font is needed; the word beside it says the same thing.
    const marks: Array<[TaskStatus, string, string]> = [
      ["applied", "[x]", "Accepted"],
      ["running", "[>]", "Running"],
      ["needs_review", "[?]", "Manager reviewing"],
      ["repairing", "[~]", "Repairing"],
      ["queued", "[ ]", "Queued"],
      ["ready", "[ ]", "Up next"],
      ["blocked", "[ ]", "Blocked by earlier tasks"],
      ["failed", "[!]", "Failed"],
      ["cancelled", "[-]", "Cancelled"],
    ];
    for (const [status, mark, label] of marks) {
      const one = running();
      one.snapshot!.tasks = [task("A task", status)];
      const lines = renderBoard(one, 80).lines;
      const at = lines.findIndex((line) => line.startsWith(`${mark} A task`));
      expect(at, status).toBeGreaterThan(-1);
      expect(lines[at + 1], status).toMatch(new RegExp(`^ {4}${label}`));
      // Every character of every mark is ASCII.
      expect(mark).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("reads clearly with no colour: the mark, the title and the state in words", () => {
    const off = createColours({ theme: "mocha", isTTY: false, env: {} });
    const text = renderBoard(running(), 100, off).lines.join("\n");
    expect(text).not.toContain("\x1b");
    expect(text).toContain("[x] Add the tokenizer module\n    Accepted · interactive");
    expect(text).toContain("[ ] Wire the tokenizer");
    expect(text).toContain("[x] means the Project Manager accepted the work.");
  });

  it("lists the evidence under a task the way the desktop's task details do", () => {
    const evidence = running();
    evidence.snapshot!.tasks = [
      task("Ship it", "failed", {
        stuck: {
          since: "",
          category: "model_capability",
          reason: "The model kept repeating itself.",
          brief: "",
        },
        attempts: [
          attempt(1, {
            status: "failed",
            error: "The worker stopped early.",
            review: { decision: "repair", reason: "Tests fail.", at: "", nextAttempt: 2 },
            result: {
              status: "failed",
              output: "",
              patches: finishedAttempt().result!.patches,
              verification: { status: "failed", reason: "npm test exited 1", commands: [] },
            },
          }),
        ],
      }),
    ];
    const text = renderBoard(evidence, 100).lines.join("\n");
    expect(text).toContain("changed  src/tokenizer.ts, tests/tokenizer.test.ts");
    expect(text).toContain("checks   failed — npm test exited 1");
    expect(text).toContain("review   Requested attempt 2 (repair): Tests fail.");
    expect(text).toContain("manager  Not accepted. The run stopped on this task.");
    expect(text).toContain("stuck    Model capability: The model kept repeating itself.");
    expect(text).toContain("error    The worker stopped early.");
  });

  it("paints a failed check and an error as faults, and a passed check as ok", () => {
    const evidence = running();
    evidence.snapshot!.tasks = [
      task("Ship it", "applied", { attempts: [finishedAttempt()] }),
      task("Break it", "failed", {
        attempts: [attempt(1, { status: "failed", error: "It broke." })],
      }),
    ];
    const raw = renderBoard(evidence, 100, colour).lines.join("\n");
    expect(raw).toContain(colour.paint("ok", "passed"));
    expect(raw).toContain(colour.paint("fault", "It broke."));
  });

  it("hangs a long title under itself and never runs past the width", () => {
    const long = running();
    long.snapshot!.tasks = [
      task("A task whose title is long enough that it has to wrap on a narrow terminal", "queued"),
    ];
    for (const width of [40, 60]) {
      const lines = renderBoard(long, width).lines;
      expect(fits(lines, width), `${width}`).toBe(true);
    }
  });

  it("keeps the project brief between the plan and the tasks, as its own section", () => {
    const withBrief = running();
    withBrief.snapshot!.brief = "Objective: slugs.";
    const text = renderBoard(withBrief, 100).lines.join("\n");
    expect(text.indexOf("Plan")).toBeLessThan(text.indexOf("Project brief"));
    expect(text.indexOf("Project brief")).toBeLessThan(text.indexOf("Tasks"));
    expect(text).toMatch(/Project brief\n─+\nObjective: slugs\./);
  });

  it("says plainly when nothing is planned", () => {
    const text = renderBoard(state({ connection: CONNECTED }), 100).lines.join("\n");
    expect(text).toContain("Nothing planned yet");
    expect(text).toContain("No tasks yet");
  });

  it("stays inside the terminal at every width, with or without colour", () => {
    for (const width of WIDTHS)
      for (const colours of [PLAIN, colour])
        expect(fits(renderBoard(running(), width, colours).lines, width), `${width}`).toBe(true);
  });
});

describe("the plan card", () => {
  const proposed = (): ProjectSnapshot =>
    snapshot({
      project: project({ status: "awaiting_approval" }),
      plan: {
        revision: 1,
        summary: "Add a health endpoint and a test.",
        acceptanceCriteria: ["GET /health returns 200"],
        authority: "",
        approved: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      tasks: [
        task("Add the endpoint", "ready"),
        task("Cover it with a test whose name is long enough to wrap on a narrow card", "blocked", {
          difficulty: "medium",
          route: "snippet",
        }),
      ],
    });

  it("numbers the tasks and says how big and where each runs", () => {
    const body = plain(planCardBody(proposed(), 80, colour) ?? []).join("\n");
    expect(body).toContain("Acceptance criteria\n  • GET /health returns 200");
    expect(body).toMatch(/Tasks\n {2}1\. Add the endpoint {2}small · interactive/);
    expect(body).toMatch(/2\. Cover it with a test/);
  });

  it("puts the size and route under a title too long to share the line", () => {
    const lines = planCardBody(proposed(), 40) ?? [];
    expect(fits(lines, 40)).toBe(true);
    expect(lines.join("\n")).toMatch(/medium · snippet/);
  });

  it("has nothing to show once the plan is approved", () => {
    const approved = proposed();
    approved.plan = { ...approved.plan!, approved: true };
    expect(planCardBody(approved, 80)).toBeUndefined();
  });
});

describe("the approval card's parts", () => {
  it("keeps the exact command out of the part a small terminal may cut", () => {
    const { facts, exact } = approvalCardParts(approval({ action: "npm run build" }), 60);
    expect(facts.join("\n")).not.toContain("npm run build");
    expect(exact.join("\n")).toContain("npm run build");
    expect(exact[0]).toBe("");
  });

  it("shows the request exactly as it will run, spaces and all", () => {
    // Someone is being asked to allow this; a run of spaces in a quoted
    // argument is part of it, and a wrap that tidied them would show another command.
    const { exact } = approvalCardParts(approval({ action: 'echo "two  spaces   here"' }), 60);
    expect(exact.join("\n")).toContain('echo "two  spaces   here"');
  });

  it("puts the label and its value on one row, and hangs the rest", () => {
    const { facts } = approvalCardParts(approval(), 40);
    expect(facts.some((line) => /^What {3}Run a command in demo\.$/.test(line))).toBe(true);
    expect(fits(facts, 40)).toBe(true);
  });

  it("breaks a path too long for the card rather than overflowing it", () => {
    const deep = `/Users/someone/${"deeply/".repeat(20)}file.ts`;
    const { facts, exact } = approvalCardParts(
      approval({ kind: "write", action: deep, cwd: deep }),
      50,
    );
    expect(fits([...facts, ...exact], 50)).toBe(true);
  });
});

describe("the setup screen", () => {
  it("groups what it shows: the connection, the models, the folders, and what to do next", () => {
    const text = renderSetup(running(), 100).lines.join("\n");
    for (const section of ["Setup", "Connection", "Models", "Extra folders", "Next"])
      expect(text).toContain(section);
    expect(text).toMatch(/manager +Qwen3\.8 27B IQ3_S +Your infrastructure/);
    expect(text).toMatch(/Reachable +yes — Poundlock 0\.9\.4/);
  });

  it("paints a missing token as needing attention and a present one as fine", () => {
    const missing = renderSetup(
      state({ connection: { url: "", tokenConfigured: false, roles: {}, rolesReady: false } }),
      100,
      colour,
    ).lines.join("\n");
    expect(missing).toContain(colour.paint("review", "(not set)"));
    const fine = renderSetup(running(), 100, colour).lines.join("\n");
    expect(fine).toContain(colour.paint("ok", "configured"));
  });

  it("marks an unreachable controller as a fault, with the reason", () => {
    const down = running({ probe: { ok: false, error: "refused" } as AppStateView["probe"] });
    expect(renderSetup(down, 100, colour).lines.join("\n")).toContain(
      colour.paint("fault", "no — refused"),
    );
  });

  it("stays inside the terminal at every width", () => {
    for (const width of WIDTHS)
      for (const colours of [PLAIN, colour])
        expect(fits(renderSetup(running(), width, colours).lines, width), `${width}`).toBe(true);
  });
});

describe("colour is decoration over the same text", () => {
  it("strips back to the plain screen for every view, at every width", () => {
    const states = [
      running(),
      running({ notice: { kind: "error", text: "It failed." } }),
      running({ approvals: [approval()] }),
      state({ connection: CONNECTED, snapshot: snapshot({ messages: [message("user", "hi")] }) }),
      state({ connection: { url: "", tokenConfigured: false, roles: {}, rolesReady: false } }),
    ];
    for (const width of WIDTHS)
      for (const s of states) {
        const status = s.snapshot
          ? projectStatusView(s.snapshot, { approvals: s.approvals })
          : undefined;
        const views: Array<(colours: typeof PLAIN) => string[]> = [
          (c) => renderTitleBar(s, width, c),
          (c) => [...renderStatusLines(s, width, c, "⠹")],
          (c) => renderBanner(s, status, width, c),
          (c) => renderNotices(s, width, c),
          (c) => renderBoard(s, width, c).lines,
          (c) => renderSetup(s, width, c).lines,
          (c) => planCardBody(s.snapshot!, width, c) ?? [],
          (c) => approvalCardParts(approval(), width, c).facts,
        ];
        for (const view of views) expect(plain(view(colour))).toEqual(view(PLAIN));
      }
  });
});
