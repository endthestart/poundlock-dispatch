/**
 * Acceptance first: a Planner whose verdicts count writes each feature's
 * end-to-end test itself, from the owner's words and scenarios, on the task
 * that must make it pass. A worker wrote an inverted warp and a test that
 * asserted it, and runs met their objective with the main job unmeasured. These
 * tests come from another model, and no worker changes them. One such test checked
 * a star's transit against a short precession formula, itself further off there than
 * the test's tolerance; a correct app could not pass.
 */
import { insideProject } from "@core/auto/acceptance";
import { freezable, isTestFile } from "@core/frozen-tests";
import type { Milestone } from "@shared/types";
import type { PlannerAnswer } from "./planner-prompts";

/** Characters in one acceptance test, at most. */
export const MAX_ACCEPTANCE_CHARS = 40_000;

export const ACCEPTANCE_RULE =
  "Acceptance first: you write each feature's acceptance test yourself, from its requirement's words and scenarios, and put it in acceptanceTests on the task that wires the feature into the app (the last of its tasks). It drives the product the way a user would (its command line, API or pages) and checks what the user gets against a truth it sets up itself, to the scenario's tolerance. A truth it computes must be accurate well within that tolerance for every input it uses: where a short formula's own error nears the tolerance (low-accuracy precession near the celestial pole, for one), use the rigorous method or a published value, or leave that input out. Use the project's test runner and conventions so its checks run it, and put acceptance in its file name. Dispatch adds it, frozen, when that task starts; the task is accepted only when it passes unchanged. Workers see it only then, so name what it drives (commands and flags, routes, page labels, file formats) in the objectives of the tasks that build them.";

/** Why a gating Planner's acceptance tests cannot be used, as sentences it can correct. */
export function acceptanceProblems(
  answer: PlannerAnswer,
  milestone: Milestone,
  /** The project's tracked files: an acceptance test is always a new file. */
  tracked: string[],
  /** A whole milestone's plan: every requirement needs a test. A review's or a cut plan's does not. */
  coverAll: boolean,
): string[] {
  const problems: string[] = [];
  const existing = new Set(tracked);
  const seen = new Set<string>();
  const covered = new Set<string>();
  for (const task of answer.tasks) {
    for (const test of task.acceptanceTests ?? []) {
      const path = test.path?.trim() ?? "";
      const name = path.split("/").at(-1) ?? "";
      if (!insideProject(path)) {
        problems.push(
          `“${task.title}” names ${JSON.stringify(path)}: give a path inside the project.`,
        );
        continue;
      }
      if (!isTestFile(path) || !freezable(path) || !/acceptance/i.test(name))
        problems.push(
          `${path} must be a test file outside build output with acceptance in its name, such as acceptance_test.rs, test_acceptance.py or acceptance.spec.ts.`,
        );
      if (existing.has(path)) problems.push(`${path} is already in the project: name a new file.`);
      if (seen.has(path)) problems.push(`${path} is written twice: give each test its own file.`);
      seen.add(path);
      if (!test.content?.trim()) problems.push(`Write the content of ${path}.`);
      else if (test.content.length > MAX_ACCEPTANCE_CHARS)
        problems.push(`${path} is longer than ${MAX_ACCEPTANCE_CHARS} characters: split it.`);
      for (const id of task.requirementIds) covered.add(id.toUpperCase());
    }
  }
  if (coverAll) {
    const missing = milestone.requirementIds.filter((id) => !covered.has(id.toUpperCase()));
    if (missing.length)
      problems.push(
        `No acceptance test covers ${missing.join(", ")}: write one on the task that wires each into the app, citing it.`,
      );
  }
  return problems;
}
