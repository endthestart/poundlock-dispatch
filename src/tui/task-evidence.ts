/**
 * `/task <number> [attempt]`: one task's evidence, as the app opens it on the
 * board. The objective and the manager's decision; the attempt's worker, route,
 * changed files, checks, mutation check, review and fix rounds; then each
 * check's output, the worker's report and the diff. Snapshots are images, so
 * the terminal names them.
 */
import { compactionEvidenceText, compactionsFromProvenance } from "@shared/compaction";
import { displaySafe } from "@shared/display-safe";
import { MAX_RECOVERIES_PER_TASK } from "@shared/policy-limits";
import { destinationLabel } from "@shared/roles";
import { stuckCategoryLabel } from "@shared/stuck-task";
import { attemptStatusLabel, changedFiles, managerDecisionText } from "@shared/task-view";
import { TASK_EXECUTION_PLACE, type TaskRecord } from "@shared/types";
import { labelled } from "./chrome.js";
import type { Colours } from "./colour.js";
import { heading, subheading, wrap } from "./render.js";

type Attempt = TaskRecord["attempts"][number];

const TASK_USAGE = "Usage: /task <number> [attempt], numbered as /board lists them";

/** The task and attempt `/task` names, by their numbers on the board. */
export function pickTask(
  tasks: TaskRecord[],
  args: string,
): { task: TaskRecord; attempt?: Attempt } {
  const [number, attemptNumber, ...extra] = args.trim().split(/\s+/).filter(Boolean);
  if (!number || extra.length || !/^\d+$/.test(number)) throw new Error(TASK_USAGE);
  const task = tasks[Number.parseInt(number, 10) - 1];
  if (!task) throw new Error(`There is no task ${number}; the board has ${tasks.length}.`);
  if (attemptNumber === undefined) return { task, attempt: task.attempts.at(-1) };
  const attempt = task.attempts.find((item) => String(item.number) === attemptNumber);
  if (!attempt)
    throw new Error(
      `Task ${number} has no attempt ${attemptNumber}; it has ${task.attempts.length}.`,
    );
  return { task, attempt };
}

function snapshotNames(attempt: Attempt): string[] {
  const kept = attempt.result?.provenance?.snapshots;
  return Array.isArray(kept) ? kept.filter((name): name is string => typeof name === "string") : [];
}

export function renderTaskEvidence(
  picked: { task: TaskRecord; attempt?: Attempt },
  fixRounds: number,
  width: number,
  colours: Colours,
): string[] {
  const { task, attempt } = picked;
  const safe = (text: string) => displaySafe(text);
  const lines = heading(colours, safe(task.title), "/chat to return", width);
  const fact = (label: string, value: string) =>
    lines.push(...labelled(colours, label, safe(value), width, 12));
  lines.push(...wrap(safe(task.objective), width), "");
  fact("Decision", managerDecisionText(task));
  fact(
    "Attempts",
    task.attempts.length
      ? task.attempts
          .map((item) => `${item.number} · ${attemptStatusLabel(item.status)}`)
          .join(", ") + (attempt && task.attempts.length > 1 ? `; showing ${attempt.number}` : "")
      : "None yet",
  );
  if (attempt) {
    fact(
      "Worker",
      `${attempt.profileName || "Not assigned"}${attempt.role ? ` · ${attempt.role} role` : ""}`,
    );
    fact(
      "Job",
      attempt.jobId ??
        (attempt.execution === "durable" ? "Not submitted" : "Interactive — no Poundlock job"),
    );
    fact(
      "Destination",
      `${attempt.execution === "durable" ? "Poundlock job" : "This Mac"}${
        attempt.dataDestination ? ` · ${destinationLabel(attempt.dataDestination)}` : ""
      }${attempt.routingRevision ? ` · route ${attempt.routingRevision}` : ""}`,
    );
  } else fact("Route", TASK_EXECUTION_PLACE);
  const patch = attempt?.result?.patches.map((item) => item.patch).join("\n") ?? "";
  const files = changedFiles(patch);
  fact("Changed", files.length ? files.join(", ") : "None reported");
  const verification = attempt?.result?.verification;
  fact(
    "Checks",
    `${verification ? verification.status : "Not reported"}${verification?.reason ? ` — ${verification.reason}` : ""}`,
  );
  const mutants = attempt?.mutation?.mutants ?? [];
  if (mutants.length)
    fact(
      "Mutation",
      `${mutants.filter((mutant) => mutant.caught).length} of ${mutants.length} small breaks caught by the checks: ${mutants
        .map((m) => `${m.path}:${m.line} ${m.change} — ${m.caught ? "caught" : "not caught"}`)
        .join("; ")}`,
    );
  if (attempt && snapshotNames(attempt).length)
    fact("Snapshots", `${snapshotNames(attempt).join(", ")} (images; the desktop app shows them)`);
  const compacted = compactionEvidenceText(compactionsFromProvenance(attempt?.result?.provenance));
  if (compacted) fact("Context", compacted);
  if (attempt?.review)
    fact(
      "Review",
      `Requested attempt ${attempt.review.nextAttempt} (${attempt.review.decision}): ${attempt.review.reason}`,
    );
  fact(
    "Fix rounds",
    `${task.repairCount} of ${fixRounds} sent back by Dispatch · Retries after interruption ${
      task.recoveryCount ?? 0
    } of ${MAX_RECOVERIES_PER_TASK}${attempt?.profileName ? ` · Model ${attempt.profileName}` : ""}`,
  );
  if (attempt?.result?.selfRepairs)
    fact(
      "Self-repairs",
      `${attempt.result.selfRepairs} time${attempt.result.selfRepairs === 1 ? "" : "s"} inside this attempt, before Dispatch saw a result — separate from the fix rounds above.`,
    );
  if (task.stuck)
    lines.push(
      "",
      colours.paint(
        "review",
        safe(`${stuckCategoryLabel(task.stuck.category)}: ${task.stuck.reason}`),
      ),
    );
  if (attempt?.error) lines.push("", colours.paint("fault", safe(`Error: ${attempt.error}`)));
  for (const check of verification?.commands ?? []) {
    lines.push(
      "",
      subheading(colours, safe(`${check.command} · exit ${check.exitCode ?? "unknown"}`)),
    );
    lines.push(...wrap(safe(check.error || check.output || "No output"), width));
  }
  if (attempt?.result?.output)
    lines.push(
      "",
      subheading(colours, "Worker report"),
      ...wrap(safe(attempt.result.output), width),
    );
  if (patch) {
    lines.push("", subheading(colours, "Diff"));
    for (const line of patch.split("\n"))
      for (const row of wrap(safe(line), width))
        lines.push(
          line.startsWith("+")
            ? colours.paint("ok", row)
            : line.startsWith("-")
              ? colours.paint("fault", row)
              : row,
        );
  }
  return lines;
}
