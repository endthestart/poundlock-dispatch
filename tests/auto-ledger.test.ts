import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { casesFromTasks, nextCase, oneLine, validateCases } from "@core/auto/cases";
import { AutoLedger } from "@core/auto/ledger";
import { caseBudgetMs, checkLimits } from "@core/auto/limits";
import {
  CACHE_EXCLUDE_PATTERNS,
  isCachePath,
  isSubstantive,
  meaningfulChanges,
  scopeViolations,
} from "@core/auto/scope";
import {
  type AutoCase,
  type AutoEvent,
  autoProgressView,
  DEFAULT_AUTO_LIMITS,
  hardHoursFor,
  type LedgerEntry,
  OUTCOME_LABELS,
  reduceAutoEvents,
} from "@shared/auto-run";
import type { TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const cases: AutoCase[] = [
  { id: "C1", title: "first", objective: "one", acceptanceCriteria: "a", dependsOn: [] },
  { id: "C2", title: "second", objective: "two", acceptanceCriteria: "b", dependsOn: ["C1"] },
];

const T0 = Date.parse("2026-09-26T00:00:00.000Z");
function entries(...events: Array<[minutes: number, AutoEvent]>): LedgerEntry[] {
  return events.map(([minutes, event], i) => ({
    seq: i + 1,
    at: new Date(T0 + minutes * 60_000).toISOString(),
    event,
  }));
}
const started: AutoEvent = {
  type: "run_started",
  runId: "r1",
  cases,
  limits: DEFAULT_AUTO_LIMITS,
  supervision: "detached",
  baseCommit: "b".repeat(40),
  model: "orion",
  isolation: "a container (node:22-slim), no network",
};

describe("auto run state", () => {
  it("derives the hard limit from the soft one and caps it at 96 hours", () => {
    expect(DEFAULT_AUTO_LIMITS.hardHours).toBe(25.75);
    expect(hardHoursFor(95, 60)).toBe(96);
  });

  it("counts cache reads apart and never toward the token limit", () => {
    const state = reduceAutoEvents(
      entries(
        [0, started],
        [1, { type: "attempt_started", caseId: "C1", attempt: 1, sessionKey: "s" }],
        [
          2,
          {
            type: "attempt_finished",
            caseId: "C1",
            attempt: 1,
            finish: "done",
            usage: { input: 10, output: 10, cacheWrite: 0, cacheRead: 10_000_000 },
          },
        ],
      ),
    );
    expect(state.usage.cacheRead).toBe(10_000_000);
    expect(
      checkLimits(
        state,
        { ...DEFAULT_AUTO_LIMITS, maxProcessedTokens: 100 },
        new Date(T0 + 60 * 60_000),
      ),
    ).toBeNull();
    expect(
      checkLimits(
        state,
        { ...DEFAULT_AUTO_LIMITS, maxProcessedTokens: 20 },
        new Date(T0 + 60 * 60_000),
      ),
    ).toMatchObject({ kind: "tokens", level: "soft" });
  });

  it("does not reset the failure streak for a bookkeeping-only checkpoint", () => {
    const state = reduceAutoEvents(
      entries(
        [0, started],
        [10, { type: "case_abandoned", caseId: "C1", reason: "x" }],
        [
          20,
          { type: "checkpoint", caseId: "C2", commit: "c", substantive: false, reviewed: false },
        ],
      ),
    );
    expect(state.consecutiveFailedCases).toBe(1);
    expect(state.substantiveAccepted).toBe(0);
  });

  it("leaves waits for a busy model out of the no-progress clock", () => {
    const hour = 3_600_000;
    const waited = reduceAutoEvents(
      entries([0, started], [180, { type: "capacity_waited", caseId: "C1", ms: 2 * hour }]),
    );
    const at = new Date(T0 + 4.5 * hour);
    expect(checkLimits(waited, DEFAULT_AUTO_LIMITS, at)).toBeNull();
    const idle = reduceAutoEvents(entries([0, started]));
    expect(checkLimits(idle, DEFAULT_AUTO_LIMITS, at)).toMatchObject({ kind: "no_progress" });
  });

  it("stops new cases at the soft limit and interrupts at the hard one", () => {
    const state = reduceAutoEvents(entries([0, started]));
    expect(checkLimits(state, DEFAULT_AUTO_LIMITS, new Date(T0 + 24 * 3_600_000))).toMatchObject({
      kind: "wall_clock",
      level: "soft",
    });
    expect(checkLimits(state, DEFAULT_AUTO_LIMITS, new Date(T0 + 26 * 3_600_000))).toMatchObject({
      kind: "wall_clock",
      level: "hard",
    });
    expect(
      caseBudgetMs(
        state,
        DEFAULT_AUTO_LIMITS,
        new Date(T0 + 25.5 * 3_600_000),
        new Date(T0 + 25.5 * 3_600_000),
      ),
    ).toBe(15 * 60_000);
  });

  it("leaves a stopped run's pause out of its limits, and never counts skipped cases", () => {
    const state = reduceAutoEvents(
      entries(
        [0, started],
        [60, { type: "case_accepted", caseId: "C1" }],
        [61, { type: "checkpoint", caseId: "C1", commit: "c", substantive: true, reviewed: false }],
        [62, { type: "case_skipped", caseId: "C2", reason: "x" }],
        [63, { type: "run_ended", outcome: "blocked_for_input", reason: "Poundlock down" }],
        // Resumed eleven hours later.
        [63 + 11 * 60, { type: "run_resumed" }],
      ),
    );
    const now = new Date(T0 + (64 + 11 * 60) * 60_000);
    expect(state.startedAt).toBe(new Date(T0 + 11 * 3_600_000).toISOString());
    expect(checkLimits(state, DEFAULT_AUTO_LIMITS, now)).toBeNull();
    expect(checkLimits(state, { ...DEFAULT_AUTO_LIMITS, maxCases: 2 }, now)).toBeNull();
    expect(checkLimits(state, { ...DEFAULT_AUTO_LIMITS, maxCases: 1 }, now)).toMatchObject({
      kind: "cases",
    });
  });

  it("keeps the run's checkpoints in the order they were made", () => {
    const state = reduceAutoEvents(
      entries(
        [0, started],
        [
          1,
          {
            type: "checkpoint",
            caseId: "C2",
            commit: "b".repeat(40),
            substantive: true,
            reviewed: false,
          },
        ],
        [
          2,
          {
            type: "checkpoint",
            caseId: "C1",
            commit: "a".repeat(40),
            substantive: true,
            reviewed: false,
          },
        ],
      ),
    );
    expect(state.checkpoints.map((c) => c.caseId)).toEqual(["C2", "C1"]);
    expect(autoProgressView(state, new Date(T0))).toContain("Last checkpoint aaaaaaa C1");
  });

  it("says verified, not reviewed, and never implies review", () => {
    const state = reduceAutoEvents(
      entries(
        [0, started],
        [1, { type: "preflight", phase: "checks", passed: true, commands: [] }],
        [5, { type: "case_accepted", caseId: "C1" }],
        [6, { type: "case_accepted", caseId: "C2" }],
        [7, { type: "run_ended", outcome: "objective_met", reason: "every case verified" }],
      ),
    );
    const text = autoProgressView(state, new Date(T0 + 8 * 60_000)).join("\n");
    expect(text).toContain("Cases 2/2 verified, not reviewed");
    expect(text).toContain("Ended: every case verified (not reviewed)");
    expect(text).toContain("Commands run in a container (node:22-slim), no network");
    for (const label of [text, ...Object.values(OUTCOME_LABELS)]) {
      expect(label).not.toMatch(/\b(approved|accepted|ready to merge|mergeable)\b/i);
      expect(label.replace(/not reviewed/g, "")).not.toMatch(/reviewed/i);
    }
  });

  it("shows the preparation phase, a wait for Poundlock and a stopped runner", () => {
    const preparing = reduceAutoEvents(entries([0, started]));
    expect(autoProgressView(preparing, new Date(T0)).at(-1)).toContain("preparing the container");
    const waiting = reduceAutoEvents(
      entries(
        [0, started],
        [1, { type: "preflight", phase: "checks", passed: true, commands: [] }],
        [
          2,
          { type: "inference_wait", caseId: "C1", attempt: 1, error: "fetch failed", seconds: 30 },
        ],
      ),
    );
    expect(waiting.waiting?.until).toBe(new Date(T0 + 2 * 60_000 + 30_000).toISOString());
    expect(autoProgressView(waiting, new Date(T0)).at(-1)).toContain(
      "waiting for Poundlock (fetch failed)",
    );
    expect(autoProgressView(waiting, new Date(T0), { runnerStopped: true }).at(-1)).toContain(
      "The runner is not running",
    );
  });

  it("clears an ending when the run is resumed", () => {
    const state = reduceAutoEvents(
      entries(
        [0, started],
        [1, { type: "run_ended", outcome: "cancelled_after_checkpoint", reason: "stopped" }],
        [2, { type: "run_resumed" }],
      ),
    );
    expect(state.outcome).toBeUndefined();
    expect(state.endedAt).toBeUndefined();
  });
});

describe("auto cases", () => {
  const task = (id: string, extra: Partial<TaskRecord> = {}) =>
    ({
      id,
      title: `task ${id}`,
      objective: `do ${id}`,
      workerPrompt: "",
      acceptanceCriteria: "works",
      dependsOn: [],
      difficulty: "medium",
      contextNote: "",
      status: "ready",
      repairCount: 0,
      attempts: [],
      ...extra,
    }) as TaskRecord;

  it("leaves out the tasks a goal's previous run gave up", () => {
    const cases = casesFromTasks(
      [
        task("T1", { status: "applied" }),
        task("T2"),
        task("T3", { dependsOn: ["T2"] }),
        task("T4"),
      ],
      new Set(["T2", "T3"]),
    );
    expect(cases.map((item) => item.id)).toEqual(["T4"]);
  });

  it("freezes open plan tasks as cases, with the manager's hints, and meets dependencies on done tasks", () => {
    const frozen = casesFromTasks([
      task("T1", { status: "applied" }),
      task("T2", {
        dependsOn: ["T1"],
        workerPrompt: "Build the thing.",
        contextNote: "It lives in src/thing.",
        filesToTouch: ["src/thing.ts"],
        reuse: ["src/util.ts: slug()"],
      }),
      task("T3", {
        dependsOn: ["T2"],
        writesTests: true,
        changesFrozenTests: true,
        requirementIds: ["R1"],
      }),
    ]);
    expect(frozen[1]).toMatchObject({
      writesTests: true,
      changesFrozenTests: true,
      requirementIds: ["R1"],
    });
    expect(frozen[0]).not.toHaveProperty("writesTests");
    expect(frozen.map((c) => [c.id, c.dependsOn])).toEqual([
      ["T2", []],
      ["T3", ["T2"]],
    ]);
    expect(frozen[0].objective).toBe(
      "Build the thing.\n\nContext from the manager: It lives in src/thing.\n\nFiles to touch: src/thing.ts\n\nReuse: src/util.ts: slug()",
    );
  });

  it("refuses case ids that could name a path or a bad ref, and keeps titles on one line", () => {
    for (const id of ["../x", "a..b", "a/b", "", "-x", "a b", "x".repeat(65)])
      expect(() => validateCases([{ ...cases[0], id }]), id).toThrow(/must be letters/);
    expect(() => validateCases([{ ...cases[0], id: "SURF-API_01.a" }])).not.toThrow();
    expect(() => validateCases([{ ...cases[0], dependsOn: "C0" as unknown as string[] }])).toThrow(
      /dependsOn as a list/,
    );
    expect(oneLine("Title\n\nDispatch-Auto-Case: C9\u001b[2J")).toBe(
      "Title Dispatch-Auto-Case: C9 [2J",
    );
  });

  it("refuses an empty plan, duplicate ids, unknown dependencies and loops", () => {
    expect(() => validateCases([])).toThrow(/no cases/);
    expect(() => validateCases([cases[0], cases[0]])).toThrow(/share the id C1/);
    expect(() => validateCases([{ ...cases[0], dependsOn: ["X"] }])).toThrow(/X, which is not/);
    expect(() =>
      validateCases([
        { ...cases[0], dependsOn: ["C2"] },
        { ...cases[1], dependsOn: ["C1"] },
      ]),
    ).toThrow(/loop/);
    expect(() => validateCases(cases)).not.toThrow();
  });

  it("skips the dependents of a failed case and resumes a running one first", () => {
    const state = reduceAutoEvents(
      entries([0, started], [1, { type: "case_blocked", caseId: "C1", reason: "needs a key" }]),
    );
    expect(nextCase(cases, state)).toEqual({
      skip: cases[1],
      reason: "depends on C1, which did not finish",
    });
    const running = reduceAutoEvents(
      entries([0, started], [1, { type: "case_started", caseId: "C1" }]),
    );
    expect(nextCase(cases, running)).toEqual({ case: cases[0] });
  });
});

describe("auto scope", () => {
  it("treats tool caches as neither violations nor changes", () => {
    for (const path of [
      "src/__pycache__/app.cpython-312.pyc",
      "__pycache__/x.pyc",
      "tests/.pytest_cache/v/cache/nodeids",
      ".mypy_cache/3.12/app.json",
      "node_modules/.cache/babel/x.json",
      "web/node_modules/.cache/vite/deps.json",
      ".coverage",
      ".coverage.host.123",
      "app/.ruff_cache/CACHEDIR.TAG",
      "tsconfig.tsbuildinfo",
      ".DS_Store",
    ])
      expect(isCachePath(path), path).toBe(true);
    for (const path of [
      "src/cache.py",
      "node_modules/left-pad/index.js",
      "docs/pycache.md",
      "coverage.md",
    ])
      expect(isCachePath(path), path).toBe(false);
    expect(
      meaningfulChanges(
        ["src/a.py", "src/__pycache__/a.pyc", ".venv/bin/python", ".venv"],
        [".venv"],
      ),
    ).toEqual(["src/a.py"]);
    expect(CACHE_EXCLUDE_PATTERNS).toContain("node_modules/.cache/");
  });

  it("refuses protected paths and anything outside the writable ones, case scope first", () => {
    const scope = {
      writable: ["src/"],
      protectedPaths: ["src/fixtures"],
      bookkeeping: ["NOTES.md"],
    };
    expect(
      scopeViolations(["src/a.ts", "src/fixtures/x.json", "NOTES.md", "README.md"], scope),
    ).toEqual(["src/fixtures/x.json", "README.md"]);
    expect(scopeViolations(["test/a.test.ts", "src/a.ts"], scope, ["test"])).toEqual(["src/a.ts"]);
    expect(scopeViolations(["anything"], {})).toEqual([]);
    expect(scopeViolations(["a/b.ts", "c.md"], { writable: ["."] })).toEqual([]);
    expect(scopeViolations(["src/a/b.ts", "lib/c.ts"], { writable: ["src/**"] })).toEqual([
      "lib/c.ts",
    ]);
    expect(scopeViolations(["sub/", "src/a.ts"], { writable: ["src/", "sub"] })).toEqual(["sub/"]);
    expect(isSubstantive(["NOTES.md"], scope)).toBe(false);
    expect(isSubstantive(["NOTES.md", "src/a.ts"], scope)).toBe(true);
  });
});

describe("auto ledger", () => {
  it("ignores a torn last line and never merges the next event into it", async () => {
    const dir = await tempDir("auto-ledger-");
    const ledger = new AutoLedger(dir);
    await ledger.append({ type: "run_resumed" });
    await writeFile(
      join(dir, "events.jsonl"),
      `${await readFile(join(dir, "events.jsonl"), "utf8")}{"seq":2,"at":"x","ev`,
    );
    const again = new AutoLedger(dir);
    expect((await again.read()).length).toBe(1);
    expect((await again.append({ type: "run_resumed" })).seq).toBe(2);
    await again.append({ type: "stop_requested", mode: "now" });
    const events = (await new AutoLedger(dir).read()).map((e) => e.event.type);
    expect(events).toEqual(["run_resumed", "run_resumed", "stop_requested"]);
  });

  it("takes and clears a stop request", async () => {
    const ledger = new AutoLedger(await tempDir("auto-control-"));
    expect(await ledger.readControl()).toBeUndefined();
    await ledger.writeControl("stop_now", "n1");
    expect(await ledger.readControl()).toMatchObject({ command: "stop_now", nonce: "n1" });
    await ledger.clearControl();
    expect(await ledger.readControl()).toBeUndefined();
  });
});
