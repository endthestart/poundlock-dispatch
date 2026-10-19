/**
 * Scores an Autopilot run for the plan's exit gates (ADR 016): requirements
 * verified, interventions after start, stops by cause, the mutation check's
 * catch rate, and hours. A blind review of the product is scored by hand.
 *
 *   node --experimental-strip-types scripts/score-goal.ts <run folder> [plan.json]
 *
 * The plan defaults to the board's, named in the run's run.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
if (!runDir || !existsSync(join(runDir, "events.jsonl"))) {
  console.error("usage: score-goal.ts <run folder> [plan.json]");
  process.exit(2);
}

interface Entry {
  at: string;
  event: { type: string; [key: string]: unknown };
}

const entries: Entry[] = readFileSync(join(runDir, "events.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Entry);
const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as {
  runId: string;
  board?: { storeRoot: string; projectId: string };
};
const planFile =
  process.argv[3] ??
  (run.board ? join(run.board.storeRoot, "projects", run.board.projectId, "plan.json") : undefined);
const plan =
  planFile && existsSync(planFile)
    ? (JSON.parse(readFileSync(planFile, "utf8")) as {
        requirements?: Array<{ id: string; verdict?: { result: string; advisory?: boolean } }>;
      })
    : undefined;

const of = (type: string) => entries.filter((entry) => entry.event.type === type);
const first = entries[0]?.at;
const last = entries.at(-1)?.at;
const hours = first && last ? (Date.parse(last) - Date.parse(first)) / 3_600_000 : 0;

const cases = new Map<string, string>();
for (const { event } of entries) {
  if (event.type === "run_started" || event.type === "cases_added")
    for (const item of event.cases as Array<{ id: string }>) cases.set(item.id, "pending");
  if (event.type === "case_accepted") cases.set(String(event.caseId), "accepted");
  if (event.type === "case_blocked") cases.set(String(event.caseId), "blocked");
  if (event.type === "case_abandoned") cases.set(String(event.caseId), "abandoned");
  if (event.type === "case_skipped") cases.set(String(event.caseId), "skipped");
}
const byStage = [...cases.values()].reduce<Record<string, number>>((counts, stage) => {
  counts[stage] = (counts[stage] ?? 0) + 1;
  return counts;
}, {});

// Interventions: everything the owner had to do after the start.
const inbox = of("inbox").map((entry) => String(entry.event.cmd));
const resumes = of("run_resumed").length;
const interventions = inbox.length + resumes;

const ends = of("run_ended").map((entry) => String(entry.event.outcome));
const mutants = of("mutation").flatMap(
  (entry) => entry.event.mutants as Array<{ caught: boolean }>,
);
const caught = mutants.filter((mutant) => mutant.caught).length;

const requirements = plan?.requirements ?? [];
const shown = requirements.filter((item) => item.verdict?.result === "shown").length;
const advisory = requirements.some((item) => item.verdict?.advisory);

const percent = (part: number, whole: number) =>
  whole ? `${Math.round((100 * part) / whole)}%` : "n/a";
const lines = [
  `# Score: ${run.runId}`,
  "",
  `- Requirements shown: ${shown}/${requirements.length} (${percent(shown, requirements.length)})${advisory ? ", advisory verdicts" : ""}`,
  `- Tasks: ${Object.entries(byStage)
    .map(([stage, count]) => `${count} ${stage}`)
    .join(", ")}`,
  `- Interventions after start: ${interventions} (${[...inbox, ...Array(resumes).fill("resume")].join(", ") || "none"})`,
  `- Stops: ${ends.join(", ") || "still running"}${of("run_ended").length ? ` — ${String(of("run_ended").at(-1)?.event.reason)}` : ""}`,
  `- Mutation catch rate: ${caught}/${mutants.length} (${percent(caught, mutants.length)})`,
  `- Milestones: ${
    of("milestone_done")
      .map((entry) => String(entry.event.milestoneId))
      .join(", ") || "none closed"
  } · reviews ${of("milestone_review").length}`,
  `- Inference waits: ${of("inference_wait").length}`,
  `- Hours: ${hours.toFixed(2)}`,
];
console.log(lines.join("\n"));
