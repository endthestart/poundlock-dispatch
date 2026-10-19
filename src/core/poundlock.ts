import {
  type CapabilityMeasurement,
  type CapabilityMeasurementStatus,
  type CapabilityName,
  type CapabilitySettingsMatch,
  type ConnectionProbe,
  type InteractiveModel,
  JOB_PERMISSIONS,
  type JobOptions,
  type JobResultView,
  type PatchView,
  permissionLabel,
  REASONING_LEVELS,
  REQUIRED_PERMISSIONS,
  type VerificationView,
} from "@shared/types";
import { sha256Text } from "./ids.js";

/** Empty IDs, names and aliases cannot resolve to a supported Poundlock profile. */
export const INFERENCE_PERMISSION_PROBE_MODEL = "";

import type { SubmitJobInput } from "@shared/job-contract";

export type { SubmitJobInput } from "@shared/job-contract";

export interface PoundlockJob {
  id: string;
  idempotency_key: string;
  model_profile_id: string;
  harness_profile_id: string;
  prompt: string;
  status: string;
  attempt_id: string;
  cancel_requested: boolean;
  result?: unknown;
  error?: unknown;
  created_at: string;
  updated_at: string;
  /** Reported by the runner once it has claimed the job. */
  wall_seconds?: number | null;
  /** When the controller will stop the job for running too long; null until claimed. */
  deadline_at?: string | null;
}

export interface PoundlockEvent {
  sequence: number;
  job_id: string;
  kind: string;
  message: string;
  payload: unknown;
  created_at: string;
}

export class PoundlockError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PoundlockError";
  }
}

export interface PoundlockApi {
  probe(): Promise<ConnectionProbe>;
  capabilities?(): Promise<import("./capabilities.js").PoundlockCapabilities>;
  preflight?(
    input: import("./preflight.js").PreflightRequest,
    signal?: AbortSignal,
  ): Promise<import("./preflight.js").PreflightResult>;
  jobOptions(): Promise<JobOptions>;
  listInteractiveModels(): Promise<InteractiveModel[]>;
  usage?(): Promise<import("@shared/types").ManagedIdentityUsageResponse>;
  submitJob(input: SubmitJobInput): Promise<PoundlockJob>;
  getJob(id: string): Promise<PoundlockJob>;
  jobEvents(id: string, after?: number): Promise<PoundlockEvent[]>;
  cancelJob(id: string): Promise<{ cancel_requested: boolean }>;
}

export class PoundlockClient implements PoundlockApi {
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get baseUrl(): string {
    return this.url.replace(/\/$/, "");
  }

  async probe(): Promise<ConnectionProbe> {
    const url = this.baseUrl;
    const missingHint = (missing: string[]) =>
      missing.length
        ? `This token is missing: ${missing.map(permissionLabel).join(", ")}. Tick those boxes on an application token in Poundlock Access.`
        : undefined;

    try {
      const ready = await this.fetchImpl(`${url}/readyz`, { signal: AbortSignal.timeout(8_000) });
      const readyBody = (await ready.json().catch(() => ({}))) as {
        status?: string;
        version?: string;
      };
      if (!ready.ok) {
        return {
          ok: false,
          url,
          ready: false,
          permissions: [],
          missingPermissions: [...REQUIRED_PERMISSIONS],
          durableModels: [],
          interactiveModels: [],
          harnesses: [],
          gitHosts: [],
          outboundNetworkAllowed: false,
          error: `Poundlock is reachable but not ready (${ready.status}).`,
          hint: "Wait for the controller to finish starting, then try again.",
        };
      }

      // Job options need job permissions, which the app itself does not; a
      // token without them still connects, with no job profiles to show.
      let options: JobOptions;
      try {
        options = await this.jobOptions();
      } catch (error) {
        if (!isAuthFailure(error)) return failFromError(url, error);
        options = {
          role: "developer",
          permissions: [],
          models: [],
          harnesses: [],
          git_hosts: [],
          outbound_network_allowed: false,
          source_limits: { bytes: 0, files: 0 },
        };
      }

      const granted = new Set(options.permissions);
      if (options.role === "operator") {
        for (const permission of [...REQUIRED_PERMISSIONS, ...JOB_PERMISSIONS])
          granted.add(permission);
      }

      let interactiveModels: InteractiveModel[] = [];
      let managedIdentities: import("@shared/types").ManagedIdentityUsage[] | undefined;
      let capabilities: import("@shared/types").PoundlockCapabilitiesView | undefined;
      try {
        interactiveModels = await this.listInteractiveModels();
        granted.add("models:read");
        managedIdentities = (await this.usage().catch(() => undefined))?.managed_identities;
        // No such endpoint (404) means a controller older than any this Dispatch
        // supports. Any other failure says nothing either way, so it is not judged.
        let judged = true;
        capabilities = await this.capabilities().catch((error) => {
          judged = error instanceof PoundlockError && error.status === 404;
          return undefined;
        });
        const { compatibilityProblem } = await import("./capabilities.js");
        const problem = judged ? compatibilityProblem(capabilities) : undefined;
        if (problem)
          return {
            ok: false,
            url,
            ready: true,
            version: readyBody.version,
            permissions: [...granted],
            missingPermissions: [],
            durableModels: [],
            interactiveModels: [],
            harnesses: [],
            gitHosts: [],
            outboundNetworkAllowed: false,
            capabilities,
            error: problem.error,
            hint: problem.hint,
          };
      } catch (error) {
        if (!isAuthFailure(error)) return failFromError(url, error);
      }

      if (options.role !== "operator") {
        try {
          if (await this.inferencePermissionGranted()) granted.add("inference:invoke");
        } catch (error) {
          return failFromError(url, error);
        }
      }

      const missingPermissions = REQUIRED_PERMISSIONS.filter(
        (permission) => !granted.has(permission),
      );

      return {
        ok: missingPermissions.length === 0,
        url,
        ready: readyBody.status === "ready" || ready.ok,
        version: readyBody.version,
        permissions: [...granted],
        missingPermissions,
        durableModels: options.models,
        interactiveModels,
        managedIdentities,
        harnesses: options.harnesses,
        gitHosts: options.git_hosts ?? [],
        outboundNetworkAllowed: Boolean(options.outbound_network_allowed),
        capabilities,
        error:
          missingPermissions.length > 0
            ? "The token connected, but it cannot run the Project Manager workflow."
            : undefined,
        hint: missingHint(missingPermissions),
      };
    } catch (error) {
      return failFromError(url, error);
    }
  }

  async jobOptions(): Promise<JobOptions> {
    const options = await this.request<JobOptions>("GET", "/api/v1/job-options");
    return {
      ...options,
      models: options.models.map((model) => ({
        ...model,
        data_destination: normalizeDestination(model.data_destination),
        thinking: normalizeThinking(model.thinking),
        capabilities: parseCapabilityMeasurements(model.capabilities),
      })),
    };
  }

  async listInteractiveModels(): Promise<InteractiveModel[]> {
    const body = await this.request<{ data?: PoundlockListedModel[] }>("GET", "/v1/models");
    return parseInteractiveModels(body.data);
  }

  async capabilities(): Promise<import("./capabilities.js").PoundlockCapabilities> {
    const { parseCapabilities } = await import("./capabilities.js");
    return parseCapabilities(await this.request("GET", "/api/v1/capabilities"));
  }

  async preflight(
    input: import("./preflight.js").PreflightRequest,
    signal?: AbortSignal,
  ): Promise<import("./preflight.js").PreflightResult> {
    const { parsePreflightResult, assertReadyPreflight } = await import("./preflight.js");
    const operation = input.operation ?? "inference";
    const body = await this.request(
      "POST",
      "/api/v1/access/preflight",
      { model: input.model, operation },
      signal,
    );
    return assertReadyPreflight(parsePreflightResult(body, operation), {
      operation,
      model: input.model,
      profileId: input.profileId,
      destination: input.destination,
    });
  }

  async usage(): Promise<import("@shared/types").ManagedIdentityUsageResponse> {
    return this.request("GET", "/api/v1/usage");
  }

  /**
   * Poundlock cb27850 authenticates valid empty-model JSON before lookup, without
   * preparing a runtime. Only 404 unknown_model_profile proves authorization;
   * unexpected non-auth responses leave inference permission indeterminate.
   */
  private async inferencePermissionGranted(): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: INFERENCE_PERMISSION_PROBE_MODEL,
        messages: [],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401 || response.status === 403) {
      await response.arrayBuffer().catch(() => undefined);
      return false;
    }
    const parsedBody = (await response.json().catch(() => null)) as {
      error?: { code?: string };
    } | null;
    if (response.status === 404 && parsedBody?.error?.code === "unknown_model_profile") {
      return true;
    }
    throw new PoundlockError(
      "Could not determine inference permission from Poundlock's response.",
      response.status,
    );
  }

  async submitJob(input: SubmitJobInput): Promise<PoundlockJob> {
    return this.request<PoundlockJob>("POST", "/api/v1/jobs", inputToPayload(input));
  }

  async getJob(id: string): Promise<PoundlockJob> {
    return this.request<PoundlockJob>("GET", `/api/v1/jobs/${encodeURIComponent(id)}`);
  }

  async jobEvents(id: string, after = 0): Promise<PoundlockEvent[]> {
    const query = after > 0 ? `?after=${after}` : "";
    const body = await this.request<PoundlockEvent[] | { events?: PoundlockEvent[] }>(
      "GET",
      `/api/v1/jobs/${encodeURIComponent(id)}/events${query}`,
    );
    return Array.isArray(body) ? body : (body.events ?? []);
  }

  async cancelJob(id: string): Promise<{ cancel_requested: boolean }> {
    return this.request("POST", `/api/v1/jobs/${encodeURIComponent(id)}/cancel`);
  }

  async downloadPatch(jobId: string, index = 0, attempt?: number): Promise<string> {
    const query = attempt ? `?attempt=${attempt}` : "";
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/patches/${index}${query}`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    return response.text();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      signal: signal ?? AbortSignal.timeout(method === "GET" ? 15_000 : 120_000),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

interface PoundlockListedModel {
  model_label?: string | null;
  id: string;
  endpoint_kind?: string;
  data_destination?: unknown;
  thinking?: unknown;
  workload_class?: string;
  uses?: string[];
  context_tokens?: number;
  context_length?: number;
  max_output_tokens?: number;
  busy?: boolean;
  occupancy?: import("@shared/types").ModelOccupancy;
  routing_revision?: string;
  capabilities?: unknown;
  poundlock?: {
    model_label?: string | null;
    profile_id?: string;
    canonical_name?: string;
    aliases?: string[];
    upstream_model?: string;
    workload_class?: string;
    uses?: string[];
    wake_policy?: string;
    context_tokens?: number;
    endpoint_kind?: string;
    data_destination?: unknown;
    thinking?: unknown;
    max_output_tokens?: number;
    busy?: boolean;
    occupancy?: import("@shared/types").ModelOccupancy;
    routing_revision?: string;
    availability?: string;
    availability_reason?: string;
    blocked_reason?: string;
    warning_reason?: string;
    connection_mode?: string;
    managed_identity_status?: string;
    capabilities?: unknown;
    reasoning?: { supported?: unknown; default?: unknown; verified_at?: unknown };
    served_model?: unknown;
    provider?: unknown;
    pricing?: unknown;
    status?: unknown;
    disabled?: unknown;
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/**
 * Contract revision 4 route facts. Anything malformed is dropped rather than
 * guessed: an unknown level is never offered, and a price without a source is
 * not a price.
 */
function parseRouteCatalog(
  meta: NonNullable<PoundlockListedModel["poundlock"]>,
): Pick<
  InteractiveModel,
  | "reasoningLevels"
  | "reasoningVerifiedAt"
  | "servedModel"
  | "provider"
  | "pricing"
  | "status"
  | "disabled"
> {
  const supported = Array.isArray(meta.reasoning?.supported) ? meta.reasoning.supported : [];
  const reasoningLevels = REASONING_LEVELS.filter((level) => supported.includes(level));
  const pricing = meta.pricing as Record<string, unknown> | null | undefined;
  const disabled = meta.disabled as Record<string, unknown> | null | undefined;
  const status =
    meta.status === "disabled" ? "disabled" : meta.status === "enabled" ? "enabled" : undefined;
  return {
    reasoningLevels,
    reasoningVerifiedAt: text(meta.reasoning?.verified_at),
    servedModel: text(meta.served_model),
    provider: text(meta.provider),
    pricing:
      pricing &&
      typeof pricing.input_per_mtok === "number" &&
      typeof pricing.output_per_mtok === "number" &&
      text(pricing.source)
        ? {
            inputPerMtok: pricing.input_per_mtok,
            outputPerMtok: pricing.output_per_mtok,
            source: text(pricing.source)!,
            refreshedAt: text(pricing.refreshed_at),
          }
        : undefined,
    status,
    disabled:
      status === "disabled"
        ? {
            reason: text(disabled?.reason) ?? "taken out of service",
            source: text(disabled?.source) ?? "poundlock",
            since: text(disabled?.since) ?? "",
            lastCheck: text(disabled?.last_check),
          }
        : undefined,
  };
}

/** Collapse /v1 alias rows into one profile. Alias entries are not extra models. */
export function parseInteractiveModels(
  data: PoundlockListedModel[] | undefined,
): InteractiveModel[] {
  const byKey = new Map<string, InteractiveModel>();
  for (const item of data ?? []) {
    const meta = item.poundlock ?? {};
    const canonical = meta.canonical_name || item.id;
    const key = meta.profile_id || canonical;
    const existing = byKey.get(key);
    const aliases = new Set([...(existing?.aliases ?? []), ...(meta.aliases ?? [])]);
    if (item.id && item.id !== canonical) aliases.add(item.id);
    aliases.delete(canonical);
    byKey.set(key, {
      id: canonical,
      name: canonical,
      modelLabel: meta.model_label ?? item.model_label ?? null,
      profileId: meta.profile_id || existing?.profileId,
      aliases: [...aliases],
      context_tokens:
        meta.context_tokens ??
        item.context_tokens ??
        item.context_length ??
        existing?.context_tokens,
      workload_class: meta.workload_class || item.workload_class || existing?.workload_class,
      uses: meta.uses ?? item.uses ?? existing?.uses,
      upstreamModel: meta.upstream_model || existing?.upstreamModel,
      wakePolicy: meta.wake_policy || existing?.wakePolicy,
      endpointKind: meta.endpoint_kind || item.endpoint_kind || existing?.endpointKind,
      dataDestination: normalizeDestination(
        meta.data_destination ?? item.data_destination ?? existing?.dataDestination,
      ),
      thinking: normalizeThinking(meta.thinking ?? item.thinking ?? existing?.thinking),
      max_output_tokens:
        meta.max_output_tokens ?? item.max_output_tokens ?? existing?.max_output_tokens,
      busy: meta.busy ?? item.busy ?? existing?.busy,
      occupancy: meta.occupancy ?? item.occupancy ?? existing?.occupancy,
      routingRevision: meta.routing_revision ?? item.routing_revision ?? existing?.routingRevision,
      availability: meta.availability ?? existing?.availability,
      availabilityReason: meta.availability_reason ?? existing?.availabilityReason,
      blockedReason: meta.blocked_reason ?? existing?.blockedReason,
      warningReason: meta.warning_reason ?? existing?.warningReason,
      connectionMode: meta.connection_mode ?? existing?.connectionMode,
      managedIdentityStatus: meta.managed_identity_status ?? existing?.managedIdentityStatus,
      capabilities: parseCapabilityMeasurements(
        meta.capabilities ?? item.capabilities ?? existing?.capabilities,
      ),
      ...parseRouteCatalog(meta),
    });
  }
  return [...byKey.values()];
}

function inputToPayload(input: SubmitJobInput): Record<string, unknown> {
  return {
    idempotency_key: input.idempotencyKey,
    model_profile_id: input.modelProfileId,
    harness_profile_id: input.harnessProfileId,
    prompt: input.prompt,
    source: input.source,
    ...(input.policy ? { policy: input.policy } : {}),
  };
}

export function requestHash(input: SubmitJobInput): string {
  return sha256Text(JSON.stringify(inputToPayload(input)));
}

export function parseJobResult(job: PoundlockJob): JobResultView {
  const result = (job.result ?? {}) as {
    patches?: Array<{ root?: string; base_revision?: string; patch?: string }>;
    output?: string;
    provenance?: Record<string, unknown>;
    cleanup?: Record<string, unknown>;
  };
  const patches: PatchView[] = (result.patches ?? []).map((patch) => {
    const text = patch.patch ?? "";
    return {
      root: patch.root ?? "",
      baseRevision: patch.base_revision ?? "",
      patch: text,
      sha256: sha256Text(text),
    };
  });
  const provenance = result.provenance ?? {};
  const verification = parseVerification(provenance.verification);
  return {
    status: job.status,
    output: result.output ?? "",
    patches,
    verification,
    provenance,
    cleanup: result.cleanup as Record<string, unknown> | undefined,
    selfRepairs: parseSelfRepairs(provenance),
  };
}

/**
 * The job's own attempt_count (1 + repairs the job made on itself, from its
 * `previous_attempts`) as the in-job repair count Dispatch surfaces
 * separately from its own `repairCount`. Missing or non-numeric counts as
 * undefined rather than 0, so callers can tell "reported zero" from "not
 * reported" (an older Poundlock).
 */
function parseSelfRepairs(provenance: Record<string, unknown>): number | undefined {
  const attemptCount = provenance.attempt_count;
  if (typeof attemptCount === "number" && Number.isFinite(attemptCount)) {
    return Math.max(0, attemptCount - 1);
  }
  const previousAttempts = provenance.previous_attempts;
  if (Array.isArray(previousAttempts)) return previousAttempts.length;
  return undefined;
}

function parseVerification(value: unknown): VerificationView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const report = value as {
    status?: string;
    reason?: string;
    failure_code?: string;
    commands?: Array<{
      command?: string;
      exit_code?: number | null;
      output?: string;
      error?: string | null;
    }>;
    changed_protected_paths?: string[];
  };
  return {
    status: report.status ?? "unverified",
    reason: report.reason,
    failureCode: report.failure_code,
    commands: (report.commands ?? []).map((command) => ({
      command: command.command ?? "",
      exitCode: command.exit_code,
      output: command.output ?? "",
      error: command.error,
    })),
    changedProtectedPaths: report.changed_protected_paths,
  };
}

async function errorFromResponse(response: Response): Promise<PoundlockError> {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; status?: number; code?: string; type?: string };
  };
  const message = body.error?.message || `Poundlock returned HTTP ${response.status}.`;
  const code = body.error?.code;
  let hint: string | undefined;
  if (response.status === 401) {
    hint =
      "Check that you pasted an application token from Poundlock Access, and that it has not been revoked.";
  } else if (response.status === 403 && code === "data_destination_confirmation_required") {
    hint =
      "This profile’s destination is unknown. Confirm operator network or external in Settings → Models before sending project context.";
  } else if (response.status === 403 && /external/.test(code ?? message)) {
    hint =
      "External profiles require an application token with Call external providers. Create a replacement token in Poundlock Access.";
  } else if (response.status === 409 && code === "capacity_in_use") {
    hint =
      "The assigned model is busy. Poundlock Dispatch will wait and retry the same request instead of starting another overlapping request.";
  } else if (response.status === 409) {
    hint =
      "This usually means the same submission key was reused with different input. Open the existing job instead of submitting again.";
  } else if (response.status === 404) {
    hint = "Confirm the controller address and that the job still exists.";
  }
  return new PoundlockError(
    message,
    response.status,
    hint,
    code,
    Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  );
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof PoundlockError && (error.status === 401 || error.status === 403);
}

function failFromError(url: string, error: unknown): ConnectionProbe {
  if (error instanceof PoundlockError) {
    return {
      ok: false,
      url,
      ready: false,
      permissions: [],
      missingPermissions: [...REQUIRED_PERMISSIONS],
      durableModels: [],
      interactiveModels: [],
      harnesses: [],
      gitHosts: [],
      outboundNetworkAllowed: false,
      error: error.message,
      hint: error.hint,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : String(cause ?? "");
  const causeCode =
    cause && typeof cause === "object" && "code" in cause ? String(cause.code ?? "") : "";
  const detail = `${message} ${causeMessage} ${causeCode}`;
  const certificateFailure = /CERT|certificate|SELF_SIGNED|UNABLE_TO_GET_ISSUER|TLS|SSL/i.test(
    detail,
  );
  const refused = /ECONNREFUSED|fetch failed|network|ENOTFOUND|EHOSTUNREACH/i.test(detail);
  return {
    ok: false,
    url,
    ready: false,
    permissions: [],
    missingPermissions: [...REQUIRED_PERMISSIONS],
    durableModels: [],
    interactiveModels: [],
    harnesses: [],
    gitHosts: [],
    outboundNetworkAllowed: false,
    error: certificateFailure
      ? `Could not verify the TLS certificate for ${url}.`
      : refused
        ? `Could not reach ${url}.`
        : message,
    hint: certificateFailure
      ? "Dispatch could not trust the certificate chain. On a managed computer, confirm the organization's certificate authority is installed in the system trust store."
      : refused
        ? "Check that Poundlock is running and that this address matches the controller, including the port."
        : "See the error above. The saved token is never sent to anyone except this Poundlock address.",
  };
}

function normalizeDestination(value: unknown): import("@shared/types").DataDestination {
  return value === "operator_network" || value === "external" ? value : "unknown";
}

function normalizeThinking(value: unknown): import("@shared/types").ProfileThinkingDefault {
  return value === "off" ? "off" : "model_default";
}

const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "code_repair_verified",
  "plan_tool_schema",
  "sealed_investigation",
];
const CAPABILITY_STATUSES: readonly CapabilityMeasurementStatus[] = [
  "qualified",
  "smoke",
  "insufficient",
];
const SETTINGS_MATCH_VALUES: readonly CapabilitySettingsMatch[] = ["exact", "different"];

/**
 * Defensive parse of the `capabilities` array published in `/v1/models` and
 * `/api/v1/job-options` (Poundlock contract phase E). An entry that fails any
 * check is dropped rather than kept half-formed — `capabilityStatus` in
 * `@shared/capabilities` already treats an absent entry as `unknown`, so
 * dropping a malformed one degrades the same way instead of throwing.
 */
function parseCapabilityMeasurements(value: unknown): CapabilityMeasurement[] {
  if (!Array.isArray(value)) return [];
  const out: CapabilityMeasurement[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = record.name;
    const status = record.status;
    if (typeof name !== "string" || !CAPABILITY_NAMES.includes(name as CapabilityName)) continue;
    if (
      typeof status !== "string" ||
      !CAPABILITY_STATUSES.includes(status as CapabilityMeasurementStatus)
    )
      continue;
    const passed = Number(record.passed);
    const attempted = Number(record.attempted);
    if (!Number.isFinite(passed) || !Number.isFinite(attempted)) continue;
    const rawSettings = record.measured_settings;
    const settings =
      rawSettings && typeof rawSettings === "object"
        ? (rawSettings as Record<string, unknown>)
        : undefined;
    const settingsMatch =
      typeof record.settings_match === "string" &&
      SETTINGS_MATCH_VALUES.includes(record.settings_match as CapabilitySettingsMatch)
        ? (record.settings_match as CapabilitySettingsMatch)
        : undefined;
    out.push({
      name: name as CapabilityName,
      status: status as CapabilityMeasurementStatus,
      passed,
      attempted,
      source: typeof record.source === "string" ? record.source : undefined,
      toolkit_version:
        typeof record.toolkit_version === "string" ? record.toolkit_version : undefined,
      run_ids: Array.isArray(record.run_ids)
        ? record.run_ids.filter((id): id is string => typeof id === "string")
        : undefined,
      identity_sha256:
        typeof record.identity_sha256 === "string" ? record.identity_sha256 : undefined,
      result_sha256: typeof record.result_sha256 === "string" ? record.result_sha256 : undefined,
      measured_at: typeof record.measured_at === "string" ? record.measured_at : undefined,
      measured_settings: settings
        ? {
            context_tokens:
              typeof settings.context_tokens === "number" ? settings.context_tokens : undefined,
            max_output_tokens:
              typeof settings.max_output_tokens === "number"
                ? settings.max_output_tokens
                : undefined,
            reasoning: typeof settings.reasoning === "string" ? settings.reasoning : undefined,
            harness: typeof settings.harness === "string" ? settings.harness : undefined,
          }
        : undefined,
      note: typeof record.note === "string" ? record.note : undefined,
      recorded_at: typeof record.recorded_at === "string" ? record.recorded_at : undefined,
      age_days: typeof record.age_days === "number" ? record.age_days : undefined,
      stale: typeof record.stale === "boolean" ? record.stale : undefined,
      settings_match: settingsMatch,
    });
  }
  return out;
}
