/** Interactive local workers stop after this budget so a stuck session cannot run forever. */
export const INTERACTIVE_ATTEMPT_MS = 45 * 60_000;

export const INTERACTIVE_ATTEMPT_LIMIT_ERROR =
  "Interactive worker reached the 45-minute attempt limit. Folder changes are retained. Request a recovery to continue this worker session.";

export function isAttemptTimeLimit(input?: { error?: string } | string): boolean {
  const error = typeof input === "string" ? input : (input?.error ?? "");
  return /45-minute attempt limit/i.test(error);
}
