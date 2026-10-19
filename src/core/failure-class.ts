import type { LoopOutcome } from "@shared/stuck-task";
import type { AttemptRecord, FailureClass } from "@shared/types";
import { isAttemptTimeLimit } from "./attempt-limit.js";
import { INFRASTRUCTURE_ERROR, isInfrastructureCode, recoveryEvidence } from "./recovery.js";

/**
 * Starts an error that is about how the project folder is set up, not about
 * the model: no worker on any profile can run until the owner changes it.
 */
export const PROJECT_SETUP_PREFIX = "project_setup:";

export function isProjectSetupError(error: string | undefined): boolean {
  return Boolean(error?.trimStart().startsWith(PROJECT_SETUP_PREFIX));
}

export function classifyAttemptFailure(input: {
  error?: string;
  /**
   * Poundlock's own reason code, when the caller has one. Matching the
   * message text is a fallback: the codes and their prose are not the same
   * thing, and reading the prose is how infrastructure events came to spend
   * the user's repair and escalation budget.
   */
  code?: string;
  verificationOutput?: string;
  denied?: boolean;
  environmentBlocked?: boolean;
  stopReason?: string;
}): FailureClass {
  if (isInfrastructureCode(input.code)) return "infrastructure";
  if (isAttemptTimeLimit(input.error)) return "infrastructure";
  if (input.denied || /approval denied|denied or cancelled/i.test(input.error ?? ""))
    return "policy";
  if (input.environmentBlocked || isProjectSetupError(input.error)) return "environment";
  if (
    input.stopReason === "length" ||
    /token limit|context (window|exhaust)/i.test(input.error ?? "")
  ) {
    return /output|completion|max_?tokens|cut off/i.test(input.error ?? "")
      ? "output_limit"
      : "context_limit";
  }
  if (input.error && /output limit|stopReason.: .length|response was cut off/i.test(input.error)) {
    return "output_limit";
  }
  // A reply with no stop reason produced nothing to review: it must not spend a fix round.
  if (
    input.error &&
    /ambiguous_inference|may already have started|^incomplete model response$/i.test(
      input.error.trim(),
    )
  ) {
    return "ambiguous_inference";
  }
  if (
    input.error &&
    /^(?:terminated|stream (?:ended|terminated)|socket hang up|unexpected end of (?:json|stream)|premature close)$/i.test(
      input.error.trim(),
    )
  ) {
    return "ambiguous_inference";
  }
  if (
    input.error &&
    (INFRASTRUCTURE_ERROR.test(input.error) ||
      /managed_identity|preflight|capabilities|capacity_in_use/i.test(input.error))
  ) {
    return "infrastructure";
  }
  if (
    input.error &&
    !/denied|approval/i.test(input.error) &&
    /worker interrupted|request was aborted|worker cancelled|interactive work interrupted|\baborted\b/i.test(
      input.error,
    )
  ) {
    return "infrastructure";
  }
  if (
    /ModuleNotFoundError|environment_blocked|command not found|uv: .*not found|virtualenv|venv|rustup could not choose a version|no default is configured|toolchain '[^']+' is not installed/i.test(
      `${input.error ?? ""}\n${input.verificationOutput ?? ""}`,
    )
  ) {
    return "environment";
  }
  return "work";
}

export function consumesRepairBudget(failure: FailureClass): boolean {
  return failure === "work";
}

export function consumesEscalationBudget(failure: FailureClass): boolean {
  return failure === "work";
}

export function isInterruptAttempt(attempt: { status?: string; error?: string }): boolean {
  if (attempt.status === "paused") return true;
  if (isAttemptTimeLimit(attempt)) return true;
  const error = attempt.error ?? "";
  return (
    !/denied|approval/i.test(error) &&
    /worker interrupted|request was aborted|worker cancelled|interactive work interrupted|\baborted\b/i.test(
      error,
    )
  );
}

/**
 * Which loop allowance (if any) a task's last attempt would consume, before
 * checking whether that allowance is exhausted. `"free"` covers attempts a
 * user caused (Pause/Wait, Dispatch closing, an explicitly denied approval)
 * and environment problems on the user's machine — Phase 1 of the failure
 * handling plan requires neither to ever spend the user's fix-round or
 * retry-after-interruption allowance. `attempt.status === "paused"` always
 * wins over the failure class: a user pause mid-attempt is free no matter
 * what the worker itself was doing when it was interrupted.
 *
 * A completed attempt whose checks failed carries no failure class (Dispatch
 * only classifies non-completed attempts); its check output is inspected the
 * same way `requestRepair` always has, to tell a missing-dependency or
 * toolchain problem (free) from an actual code defect (a repair).
 */
export function classifyLoopOutcome(last: AttemptRecord | undefined): LoopOutcome {
  if (!last) return "repair";
  if (last.status === "paused") return "free";
  const failureClass = last.failureClass;
  if (failureClass === "policy" || failureClass === "environment") return "free";
  if (failureClass === "work") return "repair";
  if (failureClass != null) return "recovery";
  const checkOutput = (last.result?.verification?.commands ?? [])
    .map((command) => `${command.error ?? ""} ${command.output}`)
    .join("\n");
  return recoveryEvidence(last.error ?? "", checkOutput) ? "free" : "repair";
}
