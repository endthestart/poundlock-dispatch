/**
 * The least a gating review must do for each requirement it calls shown. BM-D attempt 5's last
 * review read 2 files for $0.04 and passed every requirement on what earlier reviews had said,
 * with 12 of 48 hidden checks failing on a value the requirement promised and no scenario tried.
 */

import type { Requirement } from "@shared/types";
import type { PlannerAnswer } from "./planner-prompts";

export const REVIEW_DEPTH_RULE = [
  "Every review starts over. A requirement is shown only if this review shows it, whatever an earlier review said and however little has changed since. For each requirement you call shown, fill in the verdict's two lists, citing only files you read in this answer:",
  "- scenarios: each scenario by its number (S1 is 1), the files that carry it out, and what they check, with the expected value and bound.",
  "- promises: each separate thing the requirement's own words promise a user, in those words; the source files that deliver it; and what a user gets for it on an ordinary input no test picks. A scenario is only an example of the words. Look in the code for the ordinary input that gets nothing, such as a filter, an early return or a limit that drops it. When something promised comes back blank, missing or wrong for such an input, the requirement is not shown, even with every scenario passing.",
  "What you did not read in this answer is partly, not shown. Dispatch checks the files you cite against what you read.",
].join("\n");

/** Why a review's shown verdicts are not yet earned, as sentences for the Planner to correct. */
export function reviewDepthProblems(
  answer: PlannerAnswer,
  requirements: Requirement[],
  wasRead: (path: string) => boolean,
): string[] {
  const problems: string[] = [];
  const cited = (label: string, files: string[], finding: string) => {
    const unread = files.filter((path) => !wasRead(path));
    if (!files.length) problems.push(`${label} cites no file.`);
    if (unread.length)
      problems.push(`${label} cites ${unread.join(", ")}, not read in this answer.`);
    if (!finding.trim()) problems.push(`${label} does not say what you found.`);
  };
  for (const verdict of answer.verdicts) {
    if (verdict.result !== "shown") continue;
    const id = verdict.requirementId;
    const requirement = requirements.find((item) => item.id.toUpperCase() === id.toUpperCase());
    requirement?.scenarios.forEach((_, index) => {
      const entry = verdict.scenarios?.find((item) => item.scenario === index + 1);
      if (entry) cited(`${id} scenario ${index + 1}`, entry.files, entry.finding);
      else problems.push(`${id} is shown but gives no check of scenario ${index + 1}.`);
    });
    if (!verdict.promises?.length) problems.push(`${id} is shown but lists none of its promises.`);
    for (const item of verdict.promises ?? [])
      cited(`${id}'s promise “${item.promise}”`, item.files, item.finding);
  }
  if (problems.length)
    problems.push("Read what is missing and say what you found, or call that requirement partly.");
  return problems;
}
