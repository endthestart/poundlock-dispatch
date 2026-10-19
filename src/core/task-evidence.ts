import type { JobResultView, TaskRecord } from "@shared/types";

/** Recovers the changed-file list from a job result's provenance, or its patch headers. */
function changedFilesFromResult(result: JobResultView | undefined): string[] {
  const reported = result?.provenance?.changedFiles;
  if (Array.isArray(reported)) {
    return reported.filter((path): path is string => typeof path === "string");
  }
  return (result?.patches ?? []).flatMap((patch) =>
    [...patch.patch.matchAll(/^(?:--- a\/|\+\+\+ b\/)(.+)$/gm)].map((match) => match[1]),
  );
}

/** Interactive retries retain folder edits, so later validation-only attempts still own earlier files. */
export function changedFilesForReview(task: TaskRecord): string[] {
  const last = task.attempts.at(-1);
  if (last?.execution !== "interactive") return changedFilesFromResult(last?.result);
  return [...new Set(task.attempts.flatMap((attempt) => changedFilesFromResult(attempt.result)))];
}

/** True when every changed file is documentation, so verification/apply rules can relax. */
export function isDocumentationOnlyChange(files: string[]): boolean {
  return files.length > 0 && files.every((path) => /\.(?:md|txt|rst)$/i.test(path));
}

/** Content a manager can review directly when a project has no runnable checks. */
function isReviewableArtifactChange(files: string[]): boolean {
  return (
    files.length > 0 &&
    files.every((path) => /\.(?:md|txt|rst|svg|png|jpe?g|gif|webp|pdf)$/i.test(path))
  );
}

/** Explicit manager review is an alternative only for small content artifacts with no checks. */
export function canManagerReviewWithoutCheck(task: TaskRecord, required: string[]): boolean {
  const attempt = task.attempts.at(-1);
  const verification = attempt?.result?.verification;
  return Boolean(
    task.managerReviewOnly &&
      required.length === 0 &&
      attempt?.status === "completed" &&
      isReviewableArtifactChange(changedFilesForReview(task)) &&
      attempt.result?.output.trim() &&
      verification?.status === "unverified" &&
      !verification.failureCode &&
      verification.commands.length === 0,
  );
}
