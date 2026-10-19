import { compilePlanProposal, PLAN_COMPILER_VERSION } from "@core/plan-compiler";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

function project(): ProjectRecord {
  return {
    id: "project",
    name: "Example",
    archived: false,
    createdAt: "now",
    updatedAt: "now",
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: "/tmp/example",
      capturedAt: "now",
      snapshotSha256: "",
      baseRevision: "",
      includedFiles: 0,
      includedBytes: 0,
      excludedPatterns: [],
      includedUncommitted: true,
      originalFingerprint: "",
    },
    policy: defaultPolicy(),
    budget: defaultBudget(),
    integration: { headRevision: "", expectedBase: "", appliedPatchSha256: [] },
    planRevision: 0,
    managerSessionId: "manager",
    eventCursor: 0,
  };
}

describe("plan compiler", () => {
  it("frames the project as context and scopes each worker to its own task", () => {
    const task = (title: string) => ({
      title,
      objective: title,
      workerPrompt: `Do ${title}`,
      acceptanceCriteria: "Done",
      difficulty: "small" as const,
      route: "interactive" as const,
    });
    const compiled = compilePlanProposal(
      {
        summary: "Build a store and a CLI",
        acceptanceCriteria: ["CLI works"],
        tasks: [task("Store"), task("CLI")],
      },
      project(),
      { defaultMode: "assist" },
    );
    const prompt = compiled.tasks[0].workerPrompt;
    expect(prompt).toMatch(/for orientation only; other tasks own the rest/);
    expect(prompt).toMatch(/do only this/);
    expect(prompt).toMatch(/Other tasks \(not yours\):\n- CLI/);
    expect(prompt).not.toMatch(/- Store\b/);
  });

  it("derives operational policy instead of accepting it from the manager", () => {
    const value = project();
    value.policy.verification.commands = ["npm test"];
    const compiled = compilePlanProposal(
      {
        summary: "Build it",
        acceptanceCriteria: ["Tests pass"],
        tasks: [
          {
            title: "Implement",
            objective: "Implement the feature",
            workerPrompt: "Implement and test it",
            acceptanceCriteria: "Tests pass",
            difficulty: "small",
            route: "interactive",
          },
        ],
      },
      value,
      { defaultMode: "assist" },
    );
    expect(compiled.plan.compilerVersion).toBe(PLAN_COMPILER_VERSION);
    expect(compiled.plan.verificationCommands).toEqual(["npm test"]);
    expect(compiled.plan.allowDependencyDownloads).toBe(false);
    expect(compiled.plan.environmentNeed).toBe("none");
    expect(compiled.plan.authority).toMatch(/does not need package downloads/);
    expect(compiled.tasks[0]).toMatchObject({
      scope: "project",
    });
  });

  it("keeps dependency downloads gated in ask mode", () => {
    const compiled = compilePlanProposal(
      {
        summary: "Build it",
        acceptanceCriteria: ["Done"],
        tasks: [
          {
            title: "Implement",
            objective: "Implement",
            workerPrompt: "Implement",
            acceptanceCriteria: "Done",
            difficulty: "small",
          },
        ],
      },
      project(),
      { defaultMode: "ask" },
    );
    expect(compiled.plan.allowDependencyDownloads).toBe(false);
    expect(compiled.plan.authority).toMatch(
      /Ask mode still requires your approval before shell commands/,
    );
    expect(compiled.plan.authority).toMatch(/Ordinary in-project file edits do not/);
  });

  it("records requested Python environment and download authority in the visible plan", () => {
    const compiled = compilePlanProposal(
      {
        summary: "Build Django",
        acceptanceCriteria: ["App runs"],
        environmentNeed: "python",
        allowDependencyDownloads: true,
        tasks: [
          {
            title: "Implement",
            objective: "Implement",
            workerPrompt: "Implement",
            acceptanceCriteria: "Done",
            difficulty: "small",
          },
        ],
      },
      project(),
      { defaultMode: "assist" },
    );
    expect(compiled.plan.environmentNeed).toBe("python");
    expect(compiled.plan.allowDependencyDownloads).toBe(true);
    expect(compiled.plan.authority).toMatch(
      /Python project environment before the first local task/,
    );
    expect(compiled.plan.authority).toMatch(
      /installs project dependencies, through package registries only/,
    );
  });

  describe("the manager's hints for a worker", () => {
    const base = {
      title: "Add slugs",
      objective: "Add slugs",
      workerPrompt: "Add slugs",
      acceptanceCriteria: "Done",
      difficulty: "small" as const,
      route: "interactive" as const,
    };
    const compile = (task: object) =>
      compilePlanProposal(
        { summary: "S", acceptanceCriteria: ["Done"], tasks: [{ ...base, ...task }] },
        project(),
        { defaultMode: "assist" },
      );

    it("carries the context note, files to touch and reuse onto the task", () => {
      const [task] = compile({
        contextNote: "Slugs are lowercase ASCII.",
        filesToTouch: [" src/core/slug.ts ", "src/core/slug.ts"],
        reuse: ["slugify() in src/util/text.ts"],
      }).tasks;
      expect(task.contextNote).toBe("Slugs are lowercase ASCII.");
      expect(task.filesToTouch).toEqual(["src/core/slug.ts"]);
      expect(task.reuse).toEqual(["slugify() in src/util/text.ts"]);
    });

    it("leaves the fields off a task that has none, as before", () => {
      const [task] = compile({}).tasks;
      expect(task.contextNote).toBe("");
      expect("filesToTouch" in task).toBe(false);
      expect("reuse" in task).toBe(false);
      expect("filesToTouch" in compile({ filesToTouch: [], reuse: [] }).tasks[0]).toBe(false);
    });

    it("refuses a plan whose paths leave the project, naming the task", () => {
      expect(() => compile({ filesToTouch: ["../../etc/passwd"] })).toThrow(
        /Task “Add slugs”: filesToTouch entry .* must stay inside the project folder/,
      );
      expect(() => compile({ reuse: ["x".repeat(400)] })).toThrow(
        /Task “Add slugs”: a reuse entry/,
      );
    });
  });
});
