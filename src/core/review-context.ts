import { failureExcerpt, ranNoTests } from "@shared/failure-excerpt";
import type { TaskRecord, VerificationView } from "@shared/types";
import { isProjectSetupError } from "./failure-class.js";
import { expectsRedTests } from "./frozen-tests";
import {
  canManagerReviewWithoutCheck,
  changedFilesForReview,
  isDocumentationOnlyChange,
} from "./task-evidence.js";
import { wrapUntrusted } from "./untrusted.js";
import { checksPassed, UNVERIFIED_CODE_REJECTED } from "./workflow-support.js";

/** Opens every review packet; how an older one is recognised in the manager's history. */
export const REVIEW_PACKET_OPENING =
  "Review these worker results and make one explicit decision for each task now.";

export const MAX_MANAGER_REVIEW_BODY_CHARS = 7_000;
export const MAX_MANAGER_REVIEW_TURN_CHARS = 12_000;

const MAX_CHANGED_FILES = 24;
const MAX_WORKER_OUTPUT_CHARS = 800;
const MAX_VERIFICATION_CHARS = 2_500;

function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n[truncated]";
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function compactText(text: string | undefined, limit: number): string {
  return clipText((text ?? "").replace(/\s+/g, " ").trim(), limit);
}

function changedFiles(task: TaskRecord): string[] {
  return changedFilesForReview(task);
}

/**
 * A task's checks on one line, for the completion review. It sent every
 * task's full check output as JSON, which on a long project outgrew the
 * manager's window when it came to be summarised.
 */
export function checksLine(verification: VerificationView | undefined): string {
  if (!verification?.commands.length) return `no checks (${verification?.status ?? "unverified"})`;
  return verification.commands
    .map((result) => {
      const output = result.output ?? "";
      const outcome =
        result.error || result.exitCode !== 0
          ? `failed (exit ${result.exitCode ?? "unknown"}): ${compactText(result.error || failureExcerpt(output, 300), 300)}`
          : ranNoTests(output)
            ? "passed, but ran no tests"
            : "passed";
      return `${compactText(result.command, 120)} ${outcome}`;
    })
    .join("; ");
}

/** Which UI snapshots the attempt kept; the owner sees them on the task. */
function snapshotLine(kept: unknown): string {
  const names = Array.isArray(kept) ? kept.filter((name) => typeof name === "string") : [];
  return names.length ? `UI snapshots kept for the owner: ${names.slice(0, 12).join(", ")}.` : "";
}

function verificationSummary(verification: VerificationView | undefined): string {
  if (!verification) return "No verification evidence was reported.";
  const lines = [
    `Status: ${verification.status}${verification.failureCode ? ` (${verification.failureCode})` : ""}`,
    verification.reason ? `Reason: ${compactText(verification.reason, 400)}` : "",
    ...verification.commands.slice(0, 5).map((result) => {
      const outcome =
        result.error || result.exitCode !== 0
          ? `failed${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}`
          : ranNoTests(result.output ?? "")
            ? "passed, but ran no tests"
            : "passed";
      const failed = Boolean(result.error) || result.exitCode !== 0;
      const detail = failed
        ? [result.error ? compactText(result.error, 300) : "", failureExcerpt(result.output ?? "")]
            .filter(Boolean)
            .join("\n")
        : compactText(result.output, 300);
      return `- ${compactText(result.command, 240)}: ${outcome}${detail ? ` — ${detail}` : ""}`;
    }),
    verification.commands.length > 5
      ? `- ${verification.commands.length - 5} additional command result(s) omitted`
      : "",
  ].filter(Boolean);
  return wrapUntrusted("verification summary", lines.join("\n"), MAX_VERIFICATION_CHARS);
}

function reviewDirection(task: TaskRecord, files: string[], required: string[]): string {
  const attempt = task.attempts.at(-1);
  const verification = attempt?.result?.verification;
  const documentationOnly = isDocumentationOnlyChange(files);
  const managerReviewable = canManagerReviewWithoutCheck(task, required);
  if (task.stuck && !managerReviewable) {
    return "Required action: this task's fix-round or retry-after-interruption allowance is used up. Choose one of the stuck-task brief's alternatives below (request_escalation, propose_plan, or ask_user). request_repair only reproduces the same brief.";
  }
  if (attempt?.failureClass === "ambiguous_inference") {
    return "Required action: request_repair with freshSession=true so a new worker session verifies and finishes the retained files. Do not accept this incomplete response.";
  }
  if (attempt?.status === "failed" && isProjectSetupError(attempt.error)) {
    return "Required action: this is a project-setup problem, not a model or profile problem. No worker can start until the owner changes the project folder or the rule in the attempt error. Do not call request_repair or request_escalation and do not switch profiles; call ask_user and quote the attempt error.";
  }
  if (attempt?.status === "failed") {
    return "Required action: request_repair with specific findings. Do not accept a failed attempt.";
  }
  if (expectsRedTests(task, files) && verification?.status === "failed") {
    return "Required action: this task writes tests before their code, so its new tests are expected to fail until the implementation task. Call request_apply_result when the tests match the acceptance criteria, compile, the existing tests still pass, and every failure is the missing behaviour (an assertion, or a stub's not-implemented panic in source). Request a repair for wrong, missing or non-compiling tests, or a failure in the test's own setup (a missing directory or fixture, an unwrap on file I/O in the test): frozen, such a test could never pass.";
  }
  const empty = (verification?.commands ?? []).find(
    (command) => command.exitCode === 0 && ranNoTests(command.output ?? ""),
  );
  if (task.writesTests && empty) {
    return `Required action: this task writes tests, but ${compactText(empty.command, 120)} passed without running any. Request a repair so the new tests are found and run by that check.`;
  }
  // Tests can pass by expecting a "not implemented" panic; frozen, they could
  // only fail once the real code existed.
  if (task.writesTests && verification?.status === "passed") {
    return "Required action: this task writes tests before their code, yet its checks passed. Accept only if the code they test already exists. Request a repair for any test that expects the code to be missing (should_panic or xfail on a not-implemented message, a skip until implemented, a stand-in inside a test file): frozen, such a test fails once the code exists.";
  }
  if (verification?.status === "failed" || verification?.failureCode) {
    return "Required action: the reported checks failed. Call request_repair with the specific failure; do not accept this result.";
  }
  if (required.length && !checksPassed(verification, required)) {
    return `Required action: the saved project checks did not pass. Call request_repair to make the worker result ready for those checks; Dispatch must run ${required.join(" ; ")} before acceptance.`;
  }
  if (
    !managerReviewable &&
    !documentationOnly &&
    verification?.status === "unverified" &&
    !verification.commands.length &&
    !verification.failureCode
  ) {
    return `Required action: this project has no declared or discovered checks yet. ${UNVERIFIED_CODE_REJECTED} — call request_repair asking the worker to add automated tests where Dispatch discovers them (a tests/ directory or test_*.py for unittest, pytest configuration, a package.json test script, or app tests for a Django project that declares Django), then Dispatch runs them. Do not ask the user to run commands.`;
  }
  if (
    !managerReviewable &&
    !documentationOnly &&
    (!verification || verification.status !== "passed" || verification.failureCode)
  ) {
    return `Required action: request_repair to run or fix verification. ${UNVERIFIED_CODE_REJECTED}.`;
  }
  return "Decision: inspect only the files needed, then call request_apply_result if the criteria are satisfied; otherwise call request_repair with specific findings.";
}

function taskReviewSection(task: TaskRecord, required: string[]): string {
  const attempt = task.attempts.at(-1);
  const files = changedFiles(task);
  const visibleFiles = files.slice(0, MAX_CHANGED_FILES);
  const execution = attempt?.execution ?? "interactive";
  const patchEvidence =
    "Patch body omitted because Interactive edits are already in the attached workspace. Use list_project_files and read_project_file for targeted inspection.";
  const output = attempt?.result?.output
    ? wrapUntrusted("worker output excerpt", attempt.result.output, MAX_WORKER_OUTPUT_CHARS)
    : "No worker output was reported.";
  return [
    `Task ${task.id} (${compactText(task.title, 240)})`,
    reviewDirection(task, files, required),
    `Execution: ${execution}; attempt status: ${attempt?.status ?? "missing"}; failure class: ${attempt?.failureClass ?? "none"}.`,
    `Objective: ${compactText(task.objective, 500)}`,
    `Acceptance criteria: ${compactText(task.acceptanceCriteria, 500)}`,
    `Assigned: ${compactText(attempt?.profileName ?? "unknown", 160)} — ${compactText(attempt?.selectionReason, 320)}`,
    `Changed files (${files.length}): ${visibleFiles.join(", ") || "none"}${files.length > visibleFiles.length ? `, and ${files.length - visibleFiles.length} more` : ""}`,
    verificationSummary(attempt?.result?.verification),
    snapshotLine(attempt?.result?.provenance?.snapshots),
    `Attempt error: ${compactText(attempt?.error ?? "none", 500)}`,
    output,
    patchEvidence,
    task.stuck && !canManagerReviewWithoutCheck(task, required)
      ? `Stuck-task brief:\n${task.stuck.brief}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Builds the bounded evidence packet used for a manager review turn. */
export function buildManagerReviewPrompt(tasks: TaskRecord[], required: string[] = []): string {
  const instructions = [
    REVIEW_PACKET_OPENING,
    "Interactive edits are already on disk; never request or reconstruct their full patch. Use list_project_files and read_project_file only for the few files needed to resolve a concrete uncertainty.",
    "Distinguish infrastructure or incomplete-inference recovery from incorrect implementation.",
    "Call request_apply_result, request_repair, or ask_user. Do not rewrite code, inspect every changed file, restate the evidence, or end silently.",
  ].join("\n");
  const available =
    MAX_MANAGER_REVIEW_BODY_CHARS - instructions.length - Math.max(0, tasks.length - 1) * 2 - 2;
  const sectionLimit = Math.max(700, Math.floor(available / Math.max(tasks.length, 1)));
  const sections = tasks.map((task) => clipText(taskReviewSection(task, required), sectionLimit));
  return clipText(`${instructions}\n\n${sections.join("\n\n")}`, MAX_MANAGER_REVIEW_BODY_CHARS);
}

/** Caps the complete manager review turn after conversation and task context are appended. */
export function limitManagerReviewTurn(prompt: string): string {
  return clipText(prompt, MAX_MANAGER_REVIEW_TURN_CHARS);
}

/** The parts of a Pi message this module reads; anything else passes through untouched. */
export interface HistoryMessage {
  role: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
}

const DECISION_TOOLS: Readonly<Record<string, string>> = {
  request_apply_result: "accepted",
  request_repair: "repair requested",
  request_escalation: "escalated",
  ask_user: "asked the owner",
  propose_plan: "plan revised",
};
const MAX_CONDENSED_TASKS = 8;
const MAX_CONDENSED_TITLE_CHARS = 60;

export function messageText(message: HistoryMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function isReviewPacket(message: HistoryMessage): boolean {
  return message.role === "user" && messageText(message).startsWith(REVIEW_PACKET_OPENING);
}

/**
 * What the manager decided after the packet at `index`: the decision tools it
 * called before the next user message, by task where the call names one. A call
 * whose result was an error decided nothing.
 */
function decisionsAfter(
  messages: readonly HistoryMessage[],
  index: number,
): { byTask: Map<string, string>; general?: string } {
  const failed = new Set<string>();
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i].role === "user") break;
    if (messages[i].role === "toolResult" && messages[i].isError && messages[i].toolCallId)
      failed.add(String(messages[i].toolCallId));
  }
  const byTask = new Map<string, string>();
  let general: string | undefined;
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i].role === "user") break;
    if (messages[i].role !== "assistant" || !Array.isArray(messages[i].content)) continue;
    for (const part of messages[i].content as Array<Record<string, unknown>>) {
      if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
      const decision = DECISION_TOOLS[part.name];
      if (!decision || failed.has(String(part.id))) continue;
      const taskId = (part.arguments as { taskId?: unknown } | undefined)?.taskId;
      if (typeof taskId === "string") byTask.set(taskId, decision);
      else general = decision;
    }
  }
  return { byTask, general };
}

function condensedReview(messages: readonly HistoryMessage[], index: number): string {
  const tasks = [...messageText(messages[index]).matchAll(/^Task (\S+) \((.*)\)$/gm)];
  const { byTask, general } = decisionsAfter(messages, index);
  const listed = tasks.slice(0, MAX_CONDENSED_TASKS).map(([, id, title]) => {
    const short =
      title.length > MAX_CONDENSED_TITLE_CHARS
        ? `${title.slice(0, MAX_CONDENSED_TITLE_CHARS - 1)}…`
        : title;
    return `${id} “${short}”: ${byTask.get(id) ?? general ?? "no decision recorded"}`;
  });
  if (tasks.length > listed.length) listed.push(`and ${tasks.length - listed.length} more`);
  return `[Earlier review, condensed. ${listed.join("; ") || "No task was listed"}. The evidence packet, and the conversation and task state sent with it, are omitted; your current turn carries the latest.]`;
}

/**
 * The manager's history as the model should see it: every review packet but the
 * latest replaced by one line naming its tasks and what was decided.
 *
 * A review turn is up to 12,000 characters (about 3,000 tokens), with the
 * conversation and task state that were sent alongside the packet. It is decided
 * on the turn it arrives, yet stays in the session until compaction; only the
 * latest is still undecided. Call this on the copy sent to the model (Pi's
 * `context` event), so the stored session is left whole and Pi's compaction,
 * which reads the tokens of what was sent, is reached later.
 *
 * Returns the same array when there is nothing to condense.
 */
export function condenseOldReviewPackets<M extends HistoryMessage>(messages: M[]): M[] {
  const packets = messages.flatMap((message, index) => (isReviewPacket(message) ? [index] : []));
  if (packets.length < 2) return messages;
  const older = new Set(packets.slice(0, -1));
  return messages.map((message, index) => {
    if (!older.has(index)) return message;
    const text = condensedReview(messages, index);
    return {
      ...message,
      content: typeof message.content === "string" ? text : [{ type: "text", text }],
    };
  });
}
