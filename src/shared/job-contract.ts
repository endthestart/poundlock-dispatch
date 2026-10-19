export interface SubmitJobInput {
  idempotencyKey: string;
  modelProfileId: string;
  harnessProfileId: string;
  prompt: string;
  source:
    | { kind: "empty" }
    | {
        kind: "snapshot";
        files: Array<{ path: string; content_base64: string; executable: boolean }>;
      }
    | {
        kind: "git";
        repository: string;
        revision: string;
        credentials?: { username: string; token: string };
      };
  policy?: {
    verification?: {
      commands: Array<{ command: string; cwd?: string; timeout_seconds?: number }>;
      /**
       * A bare string is a strict protection: any change beneath it fails the
       * checks. `existing_only` protects what was already there but lets the job
       * add new files, such as a virtualenv, under it.
       */
      protected_paths?: Array<string | { path: string; mode: "strict" | "existing_only" }>;
    };
    network?: "inference_only" | "outbound";
    max_repairs?: number;
    /**
     * Tell the agent to resolve package versions from the registry rather
     * than from a remembered literal. Poundlock added this for Dispatch's own
     * workflow after a dogfood run pinned stale versions with the network
     * available; Dispatch had never sent it.
     */
    dependency_freshness?: boolean;
  };
}
