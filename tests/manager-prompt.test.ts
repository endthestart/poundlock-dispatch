import { describe, expect, it } from "vitest";

import { MANAGER_SYSTEM_PROMPT } from "../src/core/manager-prompt.js";

describe("manager conversation contract", () => {
  it("delegates a requested project deliverable but answers questions directly", () => {
    // GPT-6 Sol read "Generate an SVG" as a question it could answer and put
    // the file in chat; the deliverable belongs in the project.
    expect(MANAGER_SYSTEM_PROMPT).toContain("created or changed in the project");
    expect(MANAGER_SYSTEM_PROMPT).toContain("do not paste the deliverable into chat");
    // Questions stay questions: most turns need no worker at all.
    expect(MANAGER_SYSTEM_PROMPT).toContain("Answer questions directly in chat");
  });

  it("sends a worker for facts it cannot read instead of asking the user", () => {
    // Asked to review commits, the manager said it had no git access and asked
    // for the diff; a worker could have run it.
    expect(MANAGER_SYSTEM_PROMPT).toContain("facts your own tools cannot reach");
    expect(MANAGER_SYSTEM_PROMPT).toContain("call investigate");
    expect(MANAGER_SYSTEM_PROMPT).toContain("with no plan and no change to the board");
    expect(MANAGER_SYSTEM_PROMPT).toContain("Do not ask the user to fetch the facts");
  });

  it("discovers only material decisions and preserves an agreed specification", () => {
    expect(MANAGER_SYSTEM_PROMPT).toContain("Assess how complete the objective already is");
    expect(MANAGER_SYSTEM_PROMPT).toContain("one ask_user as a short numbered list");
    expect(MANAGER_SYSTEM_PROMPT).toContain("honor any question limit");
    expect(MANAGER_SYSTEM_PROMPT).toContain("If the user supplies a detailed specification");
    expect(MANAGER_SYSTEM_PROMPT).toContain(
      "When the user later says to build an already agreed specification",
    );
    expect(MANAGER_SYSTEM_PROMPT).toContain("do not restart discovery");
  });

  it("uses a reusable engineering workflow rather than a demonstration template", () => {
    expect(MANAGER_SYSTEM_PROMPT).not.toMatch(/django/i);
    expect(MANAGER_SYSTEM_PROMPT).toContain("Do not follow a framework-specific questionnaire");
    expect(MANAGER_SYSTEM_PROMPT).toContain("routine implementation choices");
    expect(MANAGER_SYSTEM_PROMPT).toContain("Save a compact working brief");
    expect(MANAGER_SYSTEM_PROMPT).toContain("project-owned implementation brief");
    expect(MANAGER_SYSTEM_PROMPT).toContain("AGENTS.md");
    expect(MANAGER_SYSTEM_PROMPT).toContain("do not instruct workers to use a host interpreter");
  });

  it("coordinates worker results within the accepted specification", () => {
    expect(MANAGER_SYSTEM_PROMPT).toContain("Continue coordinating without waiting for the user");
    expect(MANAGER_SYSTEM_PROMPT).toContain("request a bounded repair");
    expect(MANAGER_SYSTEM_PROMPT).toContain("advance dependent work");
    expect(MANAGER_SYSTEM_PROMPT).toContain("new evidence exposes a material decision");
    expect(MANAGER_SYSTEM_PROMPT).toContain("inspector keeps published items");
    expect(MANAGER_SYSTEM_PROMPT).toContain("45-minute attempt limit is a timeout");
    expect(MANAGER_SYSTEM_PROMPT).toContain("continue the same worker session");
    expect(MANAGER_SYSTEM_PROMPT).toContain(
      "503 infrastructure_unavailable names the worker profile",
    );
  });

  it("defaults attached-workspace implementation to interactive execution", () => {
    expect(MANAGER_SYSTEM_PROMPT).toContain("the default for work in the active project workspace");
    expect(MANAGER_SYSTEM_PROMPT).toContain("bootstrapping an application");
    // Durable jobs are for manual use; the manager has no path to them.
    expect(MANAGER_SYSTEM_PROMPT).not.toMatch(/durable/i);
    expect(MANAGER_SYSTEM_PROMPT).toContain(
      "Do not instruct a worker to create or replace that environment",
    );
  });

  it("has the manager hand workers what it knows, without inventing it", () => {
    // The owner's intent: workers should not search the code for what the
    // manager already holds.
    expect(MANAGER_SYSTEM_PROMPT).toContain("so it does not search the code for it");
    expect(MANAGER_SYSTEM_PROMPT).toContain("contextNote");
    expect(MANAGER_SYSTEM_PROMPT).toContain("filesToTouch");
    expect(MANAGER_SYSTEM_PROMPT).toContain("reuse");
    expect(MANAGER_SYSTEM_PROMPT).toContain("Never invent a function you have not seen");
  });

  it("has the manager break work down instead of handing off a large task", () => {
    expect(MANAGER_SYSTEM_PROMPT).toContain("You manage the project");
    expect(MANAGER_SYSTEM_PROMPT).toContain("names its files in filesToTouch");
    expect(MANAGER_SYSTEM_PROMPT).toContain("a task you would call large is a sign to split it");
  });

  it("keeps a short pinned brief of objectives, requirements and an ADR index", () => {
    expect(MANAGER_SYSTEM_PROMPT).toContain(
      "pinned project brief current with update_project_brief",
    );
    expect(MANAGER_SYSTEM_PROMPT).toContain("an index of the project's ADRs");
    expect(MANAGER_SYSTEM_PROMPT).toContain("under 4,000 characters");
    expect(MANAGER_SYSTEM_PROMPT).toContain("compaction cannot drop it");
    expect(MANAGER_SYSTEM_PROMPT).toContain("Read the ADRs and requirement documents on demand");
  });
});
