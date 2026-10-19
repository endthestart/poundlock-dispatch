/** What the edit guard saw in one worker attempt: failed edits by kind, and the loops it stopped. */
export interface EditGuardEvidence {
  /** Edit calls that ran. */
  edits: number;
  failed: number;
  /** Times the model was told a file it edits had changed on disk since it last read or wrote it. */
  stale: number;
  alreadyApplied: number;
  noChange: number;
  /** Misses answered with the closest region of the file. */
  nearestMatch: number;
  /** Edit calls refused because the file was in an edit loop and had not been read since. */
  blocked: number;
  /** Runs of failed edits on one file that reached the loop limit. */
  loops: Array<{ path: string; failures: number; blocked: number }>;
}
