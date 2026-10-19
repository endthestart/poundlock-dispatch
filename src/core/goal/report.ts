/**
 * The morning report (ADR 016): what an Autopilot run delivered, what is left,
 * why it stopped, and how to take the work. Written to the run folder when the
 * run ends; nothing in it says the work was reviewed.
 */
import type { AutoRunFile } from "@core/auto/runs";
import { type AutoRunState, OUTCOME_LABELS, processedTokens } from "@shared/auto-run";
import type { PlanRecord } from "@shared/types";

export function goalReport(run: AutoRunFile, state: AutoRunState, plan?: PlanRecord): string {
  const lines: string[] = [];
  const outcome = state.outcome ? OUTCOME_LABELS[state.outcome] : "still running";
  lines.push(`# Autopilot run ${run.runId}: ${outcome}`, "");
  if (state.endReason) lines.push(`Why it stopped: ${state.endReason}.`, "");
  const accepted = state.cases.filter((item) => item.stage === "accepted");
  lines.push(
    `${accepted.length} of ${state.cases.length} tasks verified by the project's checks. None of this work was reviewed by a person.`,
    "",
  );

  const requirements = plan?.requirements ?? [];
  if (requirements.length) {
    lines.push("## Requirements", "");
    for (const item of requirements) {
      const verdict = item.verdict
        ? `${item.verdict.result}${item.verdict.advisory ? " (advisory)" : ""}: ${item.verdict.note}`
        : "not reviewed";
      lines.push(`- **${item.id}** ${item.text} — ${verdict}`);
    }
    lines.push("");
  }

  if (plan?.milestones?.length) {
    lines.push("## Milestones", "");
    const progress = new Map((state.milestones ?? []).map((item) => [item.id, item]));
    for (const milestone of plan.milestones) {
      const seen = progress.get(milestone.id);
      const where = !seen
        ? "not reached"
        : seen.stage === "done"
          ? seen.gaps?.length
            ? `done, with gaps in ${seen.gaps.join(", ")}`
            : "verified"
          : `under way (${seen.reviews} review${seen.reviews === 1 ? "" : "s"})`;
      lines.push(`- **${milestone.id} ${milestone.title}**: ${where}`);
      for (const note of seen?.notes ?? []) lines.push(`  - Planner: ${note}`);
    }
    lines.push("");
  }

  if (state.frozenChanges?.length) {
    // Tests frozen earlier that the Planner let a task change: the owner checks these first.
    const titles = new Map(state.cases.map((item) => [item.id, item.title]));
    lines.push("## Frozen tests changed", "");
    for (const change of state.frozenChanges)
      lines.push(
        `- ${change.paths.join(", ")}, by “${titles.get(change.caseId) ?? change.caseId}”${change.reason ? `: ${change.reason}` : ""}`,
      );
    lines.push("");
  }

  const unfinished = state.cases.filter((item) => item.stage !== "accepted");
  if (unfinished.length) {
    lines.push("## Not finished", "");
    for (const item of unfinished)
      lines.push(`- ${item.title}: ${item.stage}${item.reason ? ` — ${item.reason}` : ""}`);
    lines.push("");
  }

  if (state.ownerMessages?.length) {
    lines.push("## Your messages during the run", "");
    for (const message of state.ownerMessages) lines.push(`- ${message.text}`);
    lines.push("");
  }

  lines.push("## Taking the work", "");
  const last = state.checkpoints.at(-1)?.commit;
  if (last) {
    lines.push(
      `The verified work is on branch \`${run.branch}\`, last commit \`${last.slice(0, 12)}\`, from base \`${run.baseCommit.slice(0, 12)}\`. Nothing was applied to your folder.`,
      "",
      "- In the app: Merge into folder (a fast-forward), or Export patch.",
      `- In a terminal: \`git fetch ${run.mirror} ${run.branch}:${run.branch}\``,
      "",
    );
  } else lines.push("No task was verified, so there is nothing to take.", "");

  const hours = state.startedAt
    ? ((state.endedAt ? Date.parse(state.endedAt) : Date.now()) - Date.parse(state.startedAt)) /
      3_600_000
    : 0;
  lines.push(
    "## Run",
    "",
    `- ${hours.toFixed(1)} h · ${processedTokens(state.usage).toLocaleString("en-US")} processed tokens · ${state.compactions} compactions`,
    `- Worker ${run.model}${run.goal ? ` · Planner ${run.goal.planner.model}${run.goal.advisory ? " (advising only)" : ""}` : ""}`,
    ...(state.limitsHit.length
      ? [
          `- Limits reached: ${state.limitsHit.map((hit) => `${hit.kind} (${hit.level})`).join(", ")}`,
        ]
      : []),
    "",
  );
  return lines.join("\n");
}
