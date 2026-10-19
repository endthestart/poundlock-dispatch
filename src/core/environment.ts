type EnvironmentKind = "python-uv" | "python-venv" | "configured" | "unsupported";
export type EnvironmentNeed = "none" | "python";

export interface EnvironmentSelection {
  kind: EnvironmentKind;
  python?: string;
  pythonVersion?: string;
  uv?: string;
  virtualenv?: string;
  blocked?: string;
  networkMode: "deny" | "dependency";
  /** Declared interpreter requirement, e.g. ">=3.11" from requires-python. */
  requirement?: string;
  /** Exact interpreter request passed to uv (from .python-version). */
  pin?: string;
  /** The project has uv.lock, which must be honored exactly. */
  lock?: boolean;
  /** An existing environment is reused as-is. */
  existing?: boolean;
  /** Replace a partial environment Dispatch itself created earlier. */
  recreate?: boolean;
  /** Set after prepare: this run created the environment. */
  created?: boolean;
}

/**
 * What environment preparation already did, persisted in Dispatch data so a
 * retry after a partial failure does not blindly repeat side effects.
 */
export interface PreparationState {
  created?: { virtualenv: string; tool: "uv" | "venv"; at: string };
  dependencies?: { manifest: string; at: string };
  verifiedAt?: string;
  lastError?: { step: string; message: string; at: string };
}

export interface EnvironmentPrepareContext {
  signal: AbortSignal;
  allowDownloads: boolean;
  state?: {
    read: () => Promise<PreparationState | undefined>;
    write: (state: PreparationState) => Promise<void>;
  };
  run: (input: {
    program: string;
    arguments: string[];
    capability: "install_deps" | "inspect";
    effect: "project_change" | "inspect";
    networkMode: "deny" | "dependency";
  }) => Promise<{ error?: string; output?: string }>;
}

export interface EnvironmentAdapter {
  id: string;
  detect(
    root: string,
    options?: { requested?: boolean; state?: PreparationState },
  ): Promise<EnvironmentSelection | undefined>;
  prepare(
    root: string,
    selection: EnvironmentSelection,
    context: EnvironmentPrepareContext,
  ): Promise<EnvironmentSelection>;
  workerPath(selection: EnvironmentSelection): string[] | undefined;
  verificationProgram(selection: EnvironmentSelection): { program: string; prefixArgs: string[] };
  /**
   * Bind a bare toolchain program to this environment. Unknown programs stay
   * unchanged so adapters do not need a catalog of every ecosystem.
   */
  rewriteInvocation?(
    program: string,
    args: string[],
    selection: EnvironmentSelection,
  ): { program: string; arguments: string[] } | undefined;
  briefing?(selection: EnvironmentSelection): string | undefined;
}

const ENVIRONMENT_BLOCKED = "environment_blocked";

export function blockedEnvironment(reason: string): EnvironmentSelection {
  return {
    kind: "unsupported",
    blocked: `${ENVIRONMENT_BLOCKED}: ${reason}`,
    networkMode: "deny",
  };
}
