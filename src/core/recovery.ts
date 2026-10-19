import type { InfrastructureIssue } from "@shared/types";

/**
 * The reason codes Poundlock emits for "the infrastructure was not ready",
 * as opposed to "the model produced bad work".
 *
 * This list was previously three codes the controller has never emitted —
 * `wake_pending`, `model_starting`, `model_loading` — so the real ones only
 * matched when their prose happened to contain "timed out" or "wake". When
 * they did not, an infrastructure event was classified as the model's fault
 * and spent a repair round and a slice of the escalation budget.
 *
 * Keep this in step with the controller: `scheduler.rs`, `runner.rs` and
 * `runner_sandbox.rs` are where these are produced.
 */
const INFRASTRUCTURE_CODES = [
  "capacity_in_use",
  "infrastructure_unavailable",
  "managed_identity_unavailable",
  "node_offline",
  "node_unavailable",
  "runtime_node_offline",
  "readiness_timeout",
  "ensure_failed",
  "runtime_lease_lost",
  "selected_network_unavailable",
  "runner_lost",
  "runner_interrupted",
  "cancelled_or_lease_lost",
  "cleanup_interrupted",
] as const;

export const INFRASTRUCTURE_ERROR = new RegExp(
  [
    INFRASTRUCTURE_CODES.join("|"),
    "ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network error|timed? out",
    "(?:HTTP|status|returned)\\s*[:=]?\\s*50[234]|\\b50[34] (?:Service|Gateway)",
  ].join("|"),
  "i",
);

/**
 * Classify on the structured code when Poundlock gave one. Matching prose is
 * a fallback for the paths that still carry only a message.
 */
export function isInfrastructureCode(code: string | undefined): boolean {
  return Boolean(code && (INFRASTRUCTURE_CODES as readonly string[]).includes(code));
}

export function classifyInfrastructureError(message: string): {
  issue: InfrastructureIssue;
  retryable: boolean;
} {
  if (
    /managed_identity_unavailable|managed identity|key\/generate|provision(?:ing|ed)?(?:_| )failed/i.test(
      message,
    )
  ) {
    return {
      retryable: false,
      issue: {
        code: "managed_identity",
        title: "Gateway access needs attention",
        detail:
          "Poundlock could not create this app’s private LiteLLM access key. No model request ran. Repair the LiteLLM client identity in Poundlock, then retry your message.",
      },
    };
  }
  if (/capacity_in_use|waiting_for_capacity|waiting_capacity/i.test(message)) {
    return {
      retryable: true,
      issue: {
        code: "capacity",
        title: "Waiting for model capacity",
        detail:
          "Poundlock returned capacity_in_use for this exact request. Dispatch waits and retries the same turn; catalog busy is only advisory.",
      },
    };
  }
  if (
    /node_offline|node_unavailable|runtime_node_offline|readiness_timeout|ensure_failed|\bwake|\bstarting|\bloading/i.test(
      message,
    )
  ) {
    return {
      retryable: true,
      issue: {
        code: "model_startup",
        title: "Waiting for model startup",
        detail:
          "Poundlock is waking the node or loading the selected model. Dispatch will retry automatically.",
      },
    };
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network error|timed? out/i.test(message)) {
    return {
      retryable: true,
      issue: {
        code: "network",
        title: "Waiting for Poundlock",
        detail: "Dispatch cannot currently reach Poundlock. It will retry automatically.",
      },
    };
  }
  return {
    retryable: true,
    issue: {
      code: "service",
      title: "Waiting for Poundlock",
      detail: "Poundlock is temporarily unavailable. Dispatch will retry automatically.",
    },
  };
}

export function recoveryEvidence(error: string, checkOutput: string): boolean {
  return (
    INFRASTRUCTURE_ERROR.test(error) ||
    /approval denied|cancelled|interrupted/i.test(error) ||
    /(?:ModuleNotFoundError: No module named|No module named ['"]?[A-Za-z_][\w.]*|(?:bash|sh):[^\n]*command not found|(?:error|Error):[^\n]*(?:dependency|dependencies|environment|toolchain)[^\n]*(?:missing|not found|not installed))/i.test(
      checkOutput,
    )
  );
}

const INFRASTRUCTURE_RECOVERY_COOLDOWN_MS = 60_000;

const INFRASTRUCTURE_UNAVAILABLE =
  /infrastructure_unavailable|the configured inference runtime is unavailable/i;

export function isInfrastructureUnavailableError(error?: string): boolean {
  return INFRASTRUCTURE_UNAVAILABLE.test(error ?? "");
}

/** First recovery after a 503 is allowed; identical instant repeats do not burn the budget. */
export function shouldDeferInfrastructureRecovery(
  task: {
    recoveryCount?: number;
    attempts: Array<{
      failureClass?: string;
      error?: string;
      terminalAt?: string;
      createdAt?: string;
    }>;
  },
  nowMs: number,
  cooldownMs = INFRASTRUCTURE_RECOVERY_COOLDOWN_MS,
): boolean {
  const last = task.attempts.at(-1);
  if (!last || last.failureClass !== "infrastructure") return false;
  if (!isInfrastructureUnavailableError(last.error)) return false;
  if ((task.recoveryCount ?? 0) < 1) return false;
  const at = Date.parse(last.terminalAt || last.createdAt || "");
  if (!Number.isFinite(at)) return true;
  return nowMs - at < cooldownMs;
}
