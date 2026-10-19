/**
 * One check runner for every path that accepts work (ADR 016). The interactive
 * worker ran its checks on the host and caught a test command that ran no
 * tests; auto mode ran them in its container and did not. Both now run the
 * project's checks here, through whatever executes a command for them.
 */
import { ranNoTests } from "@shared/failure-excerpt";
import type { VerificationView } from "@shared/types";

export interface CheckExecResult {
  exitCode: number | null;
  output: string;
  error?: string;
}

/** Runs one check command where the path runs commands: the host sandbox or the run's container. */
export type CheckExecutor = (command: string, signal: AbortSignal) => Promise<CheckExecResult>;

export interface CheckRunOptions {
  /**
   * Stop at a command that errors (timeout, cancel, refusal) or runs no tests.
   * A plain non-zero exit never stops the run, so a review sees every failing check.
   */
  stopOnError?: boolean;
  /** An executor error that ends the run (rethrown) rather than failing one check. */
  rethrow?: (error: unknown) => boolean;
  onCommand?: (command: string) => void;
}

export const VACUOUS_CHECK = "The test command ran no tests, so it verified nothing. Add tests.";

export async function runChecks(
  commands: string[],
  exec: CheckExecutor,
  signal: AbortSignal,
  options: CheckRunOptions = {},
): Promise<VerificationView> {
  const results: VerificationView["commands"] = [];
  for (const command of commands) {
    if (signal.aborted) break;
    options.onCommand?.(command);
    let result: CheckExecResult;
    try {
      result = await exec(command, signal);
    } catch (error) {
      if (options.rethrow?.(error)) throw error;
      results.push({
        command,
        exitCode: null,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      });
      if (options.stopOnError) break;
      continue;
    }
    const vacuous = result.exitCode === 0 && !result.error && ranNoTests(result.output);
    results.push({ command, ...result, ...(vacuous ? { error: VACUOUS_CHECK } : {}) });
    if (options.stopOnError && (result.error || vacuous)) break;
  }
  const passed =
    commands.length > 0 &&
    results.length === commands.length &&
    results.every((item) => item.exitCode === 0 && !item.error);
  return {
    status: passed ? "passed" : results.length ? "failed" : "unverified",
    commands: results,
    ...(!passed
      ? {
          reason: signal.aborted
            ? "Interrupted"
            : commands.length
              ? "Required checks failed or were not all run."
              : "No verification commands were declared or discovered for this project.",
        }
      : {}),
  };
}
