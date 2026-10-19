import { artifactOnlyCriteria } from "@core/task-size";
import {
  coverageNote,
  disputedRequirements,
  ledgerLine,
  mergeRequirements,
  parseVerdicts,
  requirementCoverage,
  settleRequirements,
  unverifiedRequirements,
} from "@shared/requirements";
import type { Requirement, TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

const task = (title: string, requirementIds: string[], status = "ready"): TaskRecord =>
  ({
    id: title,
    title,
    objective: title,
    workerPrompt: title,
    acceptanceCriteria: title,
    requirementIds,
    difficulty: "small",
    dependsOn: [],
    status,
    repairCount: 0,
    attempts: [],
  }) as unknown as TaskRecord;

const ledger: Requirement[] = [
  { id: "R1", text: "Import a folder", scenarios: ["the grid shows every photo"], status: "open" },
  {
    id: "R2",
    text: "Pick photos",
    scenarios: ["P marks the selected photo picked"],
    status: "open",
  },
];

describe("the requirement ledger", () => {
  it("keeps status across revisions and adds new requirements open", () => {
    const merged = mergeRequirements(
      [{ ...ledger[0], status: "done", evidence: "Accepted: “Import”" }, ledger[1]],
      [
        { id: "r1", text: "Import a folder or a card", scenarios: [] },
        { id: "R3", text: "Export", scenarios: [] },
      ],
    );
    expect(merged.map((item) => [item.id, item.text, item.status])).toEqual([
      ["r1", "Import a folder or a card", "done"],
      ["R2", "Pick photos", "open"],
      ["R3", "Export", "open"],
    ]);
  });

  it("is done when every task citing it is accepted", () => {
    const tasks = [task("Import core", ["R1"], "applied"), task("Import UI", ["R1"])];
    expect(settleRequirements(ledger, tasks).map((item) => item.status)).toEqual(["open", "open"]);
    tasks[1].status = "applied";
    const settled = settleRequirements(ledger, tasks);
    expect(settled[0]).toMatchObject({
      status: "done",
      evidence: "Accepted: “Import core”, “Import UI”",
    });
    expect(ledgerLine(settled)).toBe("1 of 2 requirements done");
    expect(settleRequirements([{ ...ledger[1], status: "waived" }], tasks)[0].status).toBe(
      "waived",
    );
  });

  it("names requirements no task serves and tasks that serve none", () => {
    const coverage = requirementCoverage(ledger, [task("Import", ["R1", "R9"]), task("Docs", [])]);
    expect(coverage.uncovered.map((item) => item.id)).toEqual(["R2"]);
    expect(coverage.uncited.map((item) => item.title)).toEqual(["Docs"]);
    expect(coverage.unknown).toEqual(["R9"]);
    expect(coverageNote(coverage)).toMatch(
      /no task serves R2 \(Pick photos\); “Docs” cite no requirement/,
    );
  });
});

describe("acceptance criteria about artifacts", () => {
  it("are told apart from what a user can do", () => {
    expect(
      artifactOnlyCriteria("Package.swift exists and builds with swift build; 5+ test cases"),
    ).toBe(true);
    expect(artifactOnlyCriteria("App does not crash on empty catalog")).toBe(true);
    expect(
      artifactOnlyCriteria(
        "After importing a folder, the grid shows every photo; swift test passes",
      ),
    ).toBe(false);
  });
});

describe("round-end verdicts", () => {
  it("are read one requirement per line and ignore anything else", () => {
    const report = [
      "I checked the grid controller and its tests.",
      "R1: shown — PhotoGrid.swift:40, test_grid_order",
      "- **R2** — not shown — P still unpicks (ReviewController.swift:51)",
      "R9: shown — unknown id",
      "r1: partly shown — duplicate, later wins",
    ].join("\n");
    const verdicts = parseVerdicts(report, ledger);
    expect(verdicts.get("R1")).toEqual({ result: "partly", note: "duplicate, later wins" });
    expect(verdicts.get("R2")).toEqual({
      result: "not shown",
      note: "P still unpicks (ReviewController.swift:51)",
    });
    expect(verdicts.has("R9")).toBe(false);
  });

  it("hold until the work behind them changes, and block only when not shown", () => {
    const tasks = [task("Import", ["R1"], "applied")];
    const [done] = settleRequirements(ledger, tasks);
    const judged = { ...done, verdict: { result: "not shown" as const, note: "no test", at: "t" } };
    expect(disputedRequirements([judged]).map((item) => item.id)).toEqual(["R1"]);
    expect(settleRequirements([judged], tasks)[0].verdict?.result).toBe("not shown");
    tasks.push(task("Import fix", ["R1"], "applied"));
    expect(settleRequirements([judged], tasks)[0].verdict).toBeUndefined();
    expect(
      unverifiedRequirements(settleRequirements([judged], tasks)).map((item) => item.id),
    ).toEqual(["R1"]);
  });
});
