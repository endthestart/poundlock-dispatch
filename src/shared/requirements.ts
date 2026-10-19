/**
 * The requirement ledger: the owner's requirements, which tasks serve each,
 * and whether the accepted work covers them. Pure functions over the plan and
 * board, shared by the orchestrator (gates and notes) and the plan card.
 */
import type { OwnerIssue, Requirement, TaskRecord } from "./types";

export interface ProposedRequirement {
  id: string;
  text: string;
  scenarios?: string[];
}

/** Requirement IDs compare without case or surrounding space. */
function key(id: string): string {
  return id.trim().toUpperCase();
}

/**
 * The ledger after a proposal: proposed requirements replace the text and
 * scenarios of the same ID and keep its status; unmentioned ones are kept;
 * new ones start open.
 */
export function mergeRequirements(
  existing: Requirement[] | undefined,
  proposed: ProposedRequirement[] | undefined,
): Requirement[] {
  const ledger = new Map((existing ?? []).map((item) => [key(item.id), { ...item }]));
  for (const item of proposed ?? []) {
    if (!item.id.trim() || !item.text.trim()) continue;
    const before = ledger.get(key(item.id));
    ledger.set(key(item.id), {
      id: item.id.trim(),
      text: item.text.trim(),
      scenarios: (item.scenarios ?? []).map((scenario) => scenario.trim()).filter(Boolean),
      status: before?.status ?? "open",
      ...(before?.evidence ? { evidence: before.evidence } : {}),
    });
  }
  return [...ledger.values()];
}

/** Each requirement's status from the board: done once every task citing it is accepted. */
export function settleRequirements(
  requirements: Requirement[],
  tasks: TaskRecord[],
): Requirement[] {
  return requirements.map((requirement) => {
    if (requirement.status === "waived") return requirement;
    const citing = tasks.filter((task) =>
      (task.requirementIds ?? []).some((id) => key(id) === key(requirement.id)),
    );
    const done = citing.length > 0 && citing.every((task) => task.status === "applied");
    const { evidence: _, verdict, ...rest } = requirement;
    const evidence = `Accepted: ${citing.map((task) => `“${task.title}”`).join(", ")}`;
    // A verdict judges the work it saw; new accepted work needs a new one.
    const kept = verdict && requirement.evidence === evidence ? { verdict } : {};
    return done ? { ...rest, ...kept, status: "done", evidence } : { ...rest, status: "open" };
  });
}

export interface Coverage {
  /** Requirements no task cites. */
  uncovered: Requirement[];
  /** Implementation tasks that cite no requirement. */
  uncited: TaskRecord[];
  /** IDs tasks cite that the ledger does not have. */
  unknown: string[];
}

export function requirementCoverage(requirements: Requirement[], tasks: TaskRecord[]): Coverage {
  const ids = new Set(requirements.map((item) => key(item.id)));
  const cited = new Set(tasks.flatMap((task) => (task.requirementIds ?? []).map(key)));
  return {
    uncovered: requirements.filter((item) => item.status !== "waived" && !cited.has(key(item.id))),
    uncited: tasks.filter(
      (task) =>
        !task.requirementIds?.length &&
        (!task.taskKind || task.taskKind === "closed_implementation"),
    ),
    unknown: [...cited].filter((id) => !ids.has(id)),
  };
}

/** A note for the manager's proposal result about gaps in the ledger, or an empty string. */
export function coverageNote(coverage: Coverage): string {
  const parts = [
    coverage.uncovered.length &&
      `no task serves ${coverage.uncovered.map((item) => `${item.id} (${item.text})`).join(", ")}`,
    coverage.uncited.length &&
      `${coverage.uncited.map((task) => `“${task.title}”`).join(", ")} cite no requirement`,
    coverage.unknown.length && `unknown requirement IDs: ${coverage.unknown.join(", ")}`,
  ].filter(Boolean);
  return parts.length
    ? `\n\nRequirement ledger: ${parts.join("; ")}. The owner sees uncovered requirements on the plan card, and mark_complete waits for every requirement to be done or waived.`
    : "";
}

export function openRequirements(requirements: Requirement[] | undefined): Requirement[] {
  return (requirements ?? []).filter((item) => item.status === "open");
}

export function openIssues(issues: OwnerIssue[] | undefined): OwnerIssue[] {
  return (issues ?? []).filter((issue) => !issue.raisedAt);
}

/** "5 of 7 requirements done, 1 waived": the ledger's state in a line. */
export function ledgerLine(requirements: Requirement[] | undefined): string {
  const all = requirements ?? [];
  const done = all.filter((item) => item.status === "done").length;
  const waived = all.filter((item) => item.status === "waived").length;
  return `${done} of ${all.length} requirement${all.length === 1 ? "" : "s"} done${waived ? `, ${waived} waived` : ""}`;
}

/** The ledger the manager's context carries each turn, so compaction cannot lose its IDs. */
export const LEDGER_BLOCK_MAX_CHARS = 4_000;

/**
 * The ledger as a block pinned in every manager turn: each ID, its status and
 * the owner's words, clipped, so a compacted manager can still cite a
 * requirement when only the summary of the conversation is left.
 */
export function ledgerBlock(requirements: Requirement[] | undefined): string {
  if (!requirements?.length) return "";
  const lines = requirements.map((item) => {
    const verdict =
      item.verdict && item.verdict.result !== "shown" ? `, verifier: ${item.verdict.result}` : "";
    const text = item.text.length > 110 ? `${item.text.slice(0, 109)}…` : item.text;
    return `- ${item.id} [${item.status}${verdict}]: ${text}`;
  });
  let body = "";
  for (const line of lines) {
    if (body.length + line.length + 1 > LEDGER_BLOCK_MAX_CHARS) {
      body += `\n… and ${lines.length - body.split("\n").length} more`;
      break;
    }
    body += `${body ? "\n" : ""}${line}`;
  }
  return `Requirement ledger (${ledgerLine(requirements)}). Dispatch adds it to every turn; cite these IDs in requirementIds.\n${body}`;
}

/** Done requirements the verifier has not yet judged shown. */
export function unverifiedRequirements(requirements: Requirement[] | undefined): Requirement[] {
  return (requirements ?? []).filter(
    (item) => item.status === "done" && item.verdict?.result !== "shown",
  );
}

/** Done requirements the verifier judged not, or only partly, shown. */
export function disputedRequirements(requirements: Requirement[] | undefined): Requirement[] {
  return (requirements ?? []).filter(
    (item) => item.status === "done" && item.verdict && item.verdict.result !== "shown",
  );
}

const VERDICT_LINE =
  /^\W*([A-Za-z][\w.-]*)\W*[:—–-]\s*(not shown|partly shown|partly|shown)\b\W*(.*)$/i;

/**
 * Verdicts from a verifier report written one requirement per line,
 * "R1: shown — evidence". Lines in any other shape are ignored.
 */
export function parseVerdicts(
  report: string,
  requirements: Requirement[],
): Map<string, { result: "shown" | "partly" | "not shown"; note: string }> {
  const ids = new Map(requirements.map((item) => [key(item.id), item.id]));
  const verdicts = new Map<string, { result: "shown" | "partly" | "not shown"; note: string }>();
  for (const line of report.split("\n")) {
    const match = VERDICT_LINE.exec(line.trim());
    if (!match || !ids.has(key(match[1]))) continue;
    const word = match[2].toLowerCase();
    verdicts.set(key(match[1]), {
      result: word === "shown" ? "shown" : word.startsWith("partly") ? "partly" : "not shown",
      note: match[3].trim().slice(0, 400),
    });
  }
  return verdicts;
}
