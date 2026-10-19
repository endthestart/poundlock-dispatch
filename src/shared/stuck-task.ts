import { nextEscalation, rungOfTask } from "./escalation";
import { failureExcerpt } from "./failure-excerpt";
import { MAX_RECOVERIES_PER_TASK, MAX_REPAIRS_PER_TASK } from "./policy-limits";
import type { RoleBinding } from "./roles";
import type { AttemptRecord, CapabilityName, FailureClass, TaskRecord } from "./types";

/**
 * Why a task's fix-round or retry-after-interruption allowance ran out, in
 * plain terms the manager and the user both act on. Computed by
 * `categorizeStuckTask`, a pure function so every branch is testable.
 */
type StuckCategory =
  | "work_quality"
  | "model_capability"
  | "model_availability"
  | "environment"
  | "policy";

/** Structured evidence kept on a task once its loop budget is used up. */
export interface TaskStuckState {
  since: string;
  category: StuckCategory;
  /** One-line actual issue from the last attempt. */
  reason: string;
  /** The full stuck-task brief handed to the manager and shown to the user. */
  brief: string;
}

/**
 * How many of a task's attempts count toward the separate worker-attempt
 * limit (`maxWorkerAttemptsPerTask`), after excluding retries-after-
 * interruption and any attempts an explicit user decision or escalation
 * forgave (`attemptBudgetOffset`). Never negative.
 */
export function stuckCategoryLabel(category: StuckCategory): string {
  switch (category) {
    case "work_quality":
      return "Work quality";
    case "model_capability":
      return "Model capability";
    case "model_availability":
      return "Model availability";
    case "environment":
      return "Environment";
    case "policy":
      return "Policy";
  }
}

/** Which loop allowance a task's last attempt would consume, before free/exhausted checks. */
export type LoopOutcome = "repair" | "recovery" | "free";

/**
 * The failure category behind an exhausted loop, from the outcome that
 * exhausted it (fix rounds vs retries after interruption) and the last
 * attempt's failure class. Pure and exhaustively testable: no I/O, no clock.
 */
export function categorizeStuckTask(
  outcome: "repair" | "recovery",
  failureClass?: FailureClass,
): StuckCategory {
  if (failureClass === "policy") return "policy";
  if (failureClass === "environment") return "environment";
  if (outcome === "repair") return "work_quality";
  if (failureClass === "context_limit" || failureClass === "output_limit")
    return "model_capability";
  return "model_availability";
}

function compact(text: string | undefined, limit: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1))}…`;
}

/** The actual issue for one attempt: a failed check, a worker error, or a controller/transport problem. */
function attemptIssue(attempt: AttemptRecord | undefined): string {
  if (!attempt) return "No attempt was recorded.";
  const verification = attempt.result?.verification;
  const failedCommand = verification?.commands.find(
    (command) => command.error || (command.exitCode ?? 0) !== 0,
  );
  if (failedCommand) {
    // The failing tests, not the head of the output: cargo starts with warnings.
    const detail = compact(failedCommand.error || failureExcerpt(failedCommand.output, 300), 200);
    return `Check "${compact(failedCommand.command, 120)}" failed${
      failedCommand.exitCode != null ? ` (exit ${failedCommand.exitCode})` : ""
    }${detail ? `: ${detail}` : "."}`;
  }
  if (attempt.error) return compact(attempt.error, 220);
  if (verification?.reason) return `Verification: ${compact(verification.reason, 200)}`;
  const missed = missedMutations(attempt);
  if (missed.length)
    return `Checks pass, but the mutation check broke ${missed.join("; ")} and no check noticed.`;
  if (verification?.status === "passed")
    return "Its checks passed; the fix rounds ran out on further work you asked for.";
  return "The attempt ended without a recorded error.";
}

/** "path:line `a` → `b`" for each break the attempt's mutation check did not catch. */
function missedMutations(attempt: AttemptRecord | undefined): string[] {
  return (attempt?.mutation?.mutants ?? [])
    .filter((mutant) => !mutant.caught)
    .map((mutant) => `${mutant.path}:${mutant.line} ${mutant.change}`);
}

interface StuckTaskBriefInput {
  task: TaskRecord;
  outcome: "repair" | "recovery";
  /** Fix rounds this task was allowed (Settings or project); absent means the default. */
  fixRounds?: number;
  escalation: import("./escalation").EscalationSettings;
  /**
   * External-provider escalation transitions already used this run (not this
   * plan revision — approving a revised plan does not refresh this). A rung
   * on the operator's own infrastructure never counts here; it is bounded
   * only by the ladder, per task.
   */
  externalEscalationsUsed: number;
  /**
   * When the last attempt's profile has published a `qualified` or `smoke`
   * measurement for the capability the task's `taskKind` requires, name it
   * here so `buildStuckTaskBrief` can call out suspect evidence: the profile
   * claimed this capability, yet the attempt failed in a way that looks like
   * the same gap. Feeds back into re-qualification. Omit when the task has no
   * `taskKind`, the profile has no measurement for it, or the category is not
   * `model_capability`.
   */
  claimedCapability?: { name: CapabilityName; status: "qualified" | "smoke"; measuredAt?: string };
  /** Escalation profiles the owner declined this run; not offered again. */
  declinedProfiles?: string[];
}

interface StuckTaskBrief {
  category: StuckCategory;
  reason: string;
  brief: string;
}

/**
 * The stuck-task brief handed to the manager as the exhausted tool call's
 * result, and shown (via `task.stuck`) in the review packet and the user's
 * decision card. Names the actual per-attempt issue, the category, what is on
 * disk, the counters used, and every alternative with its own limit — never a
 * prose dead end.
 */
export function buildStuckTaskBrief(input: StuckTaskBriefInput): StuckTaskBrief {
  const { task } = input;
  const last = task.attempts.at(-1);
  const category = categorizeStuckTask(input.outcome, last?.failureClass);
  const reason = attemptIssue(last);
  const attemptLines = task.attempts
    .map((attempt, index) => `${index + 1}. ${attempt.status} — ${attemptIssue(attempt)}`)
    .join("\n");
  const onDisk =
    "Edits are already written in the project folder; they are kept but not accepted as final.";
  const counters = `Fix rounds used: ${task.repairCount} of ${input.fixRounds ?? MAX_REPAIRS_PER_TASK} — Dispatch resending the task for a new attempt. Retries after interruption used: ${task.recoveryCount ?? 0} of ${MAX_RECOVERIES_PER_TASK}.`;
  let nextProfile: RoleBinding | undefined;
  try {
    nextProfile = nextEscalation(input.escalation, rungOfTask(input.escalation, task));
  } catch {
    nextProfile = undefined;
  }
  const remainingExternal = Math.max(
    0,
    input.escalation.maxTransitionsPerRun - input.externalEscalationsUsed,
  );
  const externalAllowanceLine =
    remainingExternal > 0
      ? `${remainingExternal} of ${input.escalation.maxTransitionsPerRun} escalation transitions to an external provider remain this run (unaffected by plan revisions). A rung on your own infrastructure never spends this limit.`
      : `The escalation transition limit for external providers (${input.escalation.maxTransitionsPerRun} this run) is used up; ask the user before escalating to one. A rung on your own infrastructure never spends this limit and may still be available.`;
  const escalationLine = nextProfile
    ? `Next eligible rung: ${nextProfile.profileName}. ${externalAllowanceLine}`
    : "No further rung is configured for this task's execution path.";
  const ladder = input.escalation.profiles.map((profile) => profile.profileName);
  const declined = nextProfile && input.declinedProfiles?.includes(nextProfile.profileId);
  const escalateAlternative = declined
    ? `The owner declined escalation to ${nextProfile?.profileName} in this run; do not request it. Revise the plan, or call ask_user to offer a retry on the current rung: the owner's answer resets this task's fix rounds.`
    : category === "model_availability"
      ? `This is a capacity or availability problem, not a capability gap: request_escalation is for quality and capability gaps, and Dispatch rejects it for busy, sleeping, network or other operational failures. Ask the user whether to keep waiting on ${last?.profileName ?? "the current rung"}, choose a different rung, or revise the plan.`
      : `Escalate to the next rung, keeping the partial result: call request_escalation (target "worker", taskId "${task.id}"). ${escalationLine}`;
  const alternatives = [
    // Out of fix rounds over an untested line, not failing work: accepting
    // it and planning the test keeps the run moving.
    ...(last?.status === "completed" && last.result?.verification?.status === "passed"
      ? [
          missedMutations(last).length
            ? "Accept it as is: its checks pass, and the mutation check runs once per attempt, so request_apply_result now succeeds. Then add a small task with a test that fails when that behaviour breaks."
            : "Accept it as is with request_apply_result: its checks pass. Put what is left in its own task with delegate_task, so it gets fresh fix rounds.",
        ]
      : []),
    escalateAlternative,
    ...(declined
      ? []
      : [
          "Start over on the escalated rung with a fresh session: after an escalation grant, call request_repair with freshSession=true.",
        ]),
    ladder.length > 1
      ? `A different eligible rung may already be reachable if ${last?.profileName ?? "the current rung"} is unavailable: the configured ladder is ${ladder.join(", ")}.`
      : "No other rung is configured to fall back to; the user can add one in Model ladder settings.",
    "Revise the plan: call propose_plan with a simplified or split approach for the user to approve.",
    "Ask the user: call ask_user when the decision needs them.",
  ]
    .map((line) => `- ${line}`)
    .join("\n");
  const claim = input.claimedCapability;
  const suspectEvidenceLine =
    category === "model_capability" && claim
      ? `Suspect evidence: ${last?.profileName ?? "the selected profile"} claimed ${claim.name} (${claim.status}) as of ${claim.measuredAt ?? "an unrecorded date"}, but this attempt failed in a way that looks like the same capability gap. Worth re-qualifying.`
      : undefined;
  const brief = [
    `Task "${task.title}" is stuck (${stuckCategoryLabel(category)}): ${reason}`,
    `Attempts:\n${attemptLines}`,
    `On disk: ${onDisk}`,
    counters,
    ...(suspectEvidenceLine ? [suspectEvidenceLine] : []),
    "request_repair on this task returns this same brief until you choose one of these:",
    alternatives,
  ].join("\n\n");
  return { category, reason, brief };
}
