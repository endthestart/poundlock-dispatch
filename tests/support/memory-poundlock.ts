import { newId, nowIso } from "@core/ids";
import {
  type PoundlockApi,
  PoundlockError,
  type PoundlockEvent,
  type PoundlockJob,
  requestHash,
  type SubmitJobInput,
} from "@core/poundlock";
import type {
  ConnectionProbe,
  InteractiveModel,
  JobOptions,
  PoundlockModelProfile,
} from "@shared/types";

export const SAMPLE_MODEL: PoundlockModelProfile = {
  id: "model-durable",
  name: "coding",
  aliases: ["coding"],
  model_id: "local-coder",
  context_tokens: 32768,
  max_output_tokens: 4096,
  workload_class: "durable-coding-agent",
  uses: ["durable"],
  wake_policy: "on-demand",
  last_check_ok: true,
  last_checked_at: "2026-09-11T00:00:00Z",
  last_check_message: "fixture",
};

const SAMPLE_PATCH = `diff --git a/hello-from-worker.txt b/hello-from-worker.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/hello-from-worker.txt
@@ -0,0 +1 @@
+hello from worker
`;

export class MemoryPoundlock implements PoundlockApi {
  jobs = new Map<string, PoundlockJob & { requestHash: string }>();
  keys = new Map<string, string>();
  events = new Map<string, PoundlockEvent[]>();
  submits = 0;
  outboundNetworkAllowed = false;
  models: PoundlockModelProfile[] = [SAMPLE_MODEL];

  async probe(): Promise<ConnectionProbe> {
    return {
      ok: true,
      url: "http://memory.example",
      ready: true,
      version: "test",
      permissions: ["models:read", "inference:invoke", "jobs:read", "jobs:submit", "jobs:cancel"],
      missingPermissions: [],
      durableModels: this.models,
      interactiveModels: [{ id: "coding" }],
      harnesses: [{ id: "pi", name: "Pi", kind: "pi", version: "1.0.0" }],
      gitHosts: ["github.com"],
      outboundNetworkAllowed: false,
    };
  }

  async jobOptions(): Promise<JobOptions> {
    return {
      role: "developer",
      permissions: ["jobs:read", "jobs:submit", "jobs:cancel"],
      models: this.models,
      harnesses: [{ id: "pi", name: "Pi", kind: "pi", version: "1.0.0" }],
      git_hosts: ["github.com"],
      outbound_network_allowed: this.outboundNetworkAllowed,
      source_limits: { bytes: 50 * 1024 * 1024, files: 10_000 },
    };
  }

  async listInteractiveModels(): Promise<InteractiveModel[]> {
    return [
      {
        id: "coding",
        profileId: "coding",
        context_tokens: 32768,
        max_output_tokens: 4096,
        dataDestination: "operator_network",
        workload_class: "interactive-coding",
        uses: ["interactive"],
      },
    ];
  }

  async capabilities() {
    return {
      api_major: 1,
      contract_revision: 3,
      features: [
        "access_preflight",
        "availability_reasons",
        "data_destination",
        "durable_jobs",
        "external_invoke_permission",
        "managed_application_identities",
        "routing_revision",
        "usage_summary",
        "verifier_toolchain",
      ],
    };
  }

  async preflight(input: { model: string; operation?: "inference" | "job" }) {
    return {
      operation: input.operation ?? "inference",
      access_state: "ready",
      destination: "operator_network",
    };
  }

  async submitJob(input: SubmitJobInput): Promise<PoundlockJob> {
    const hash = requestHash(input);
    const existingId = this.keys.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.jobs.get(existingId)!;
      if (existing.requestHash !== hash) {
        throw new PoundlockError("idempotency key was reused for different input", 409);
      }
      return this.publicJob(existing);
    }
    this.submits += 1;
    const id = newId("job");
    const now = nowIso();
    const job: PoundlockJob & { requestHash: string } = {
      id,
      idempotency_key: input.idempotencyKey,
      model_profile_id: input.modelProfileId,
      harness_profile_id: input.harnessProfileId,
      prompt: input.prompt,
      status: "completed",
      attempt_id: newId("attempt"),
      cancel_requested: false,
      created_at: now,
      updated_at: now,
      requestHash: hash,
      result: this.resultPayload(input),
    };
    this.jobs.set(id, job);
    this.keys.set(input.idempotencyKey, id);
    this.events.set(id, [
      {
        sequence: 1,
        job_id: id,
        kind: "accepted",
        message: "accepted",
        payload: {},
        created_at: now,
      },
    ]);
    return this.publicJob(job);
  }

  async getJob(id: string): Promise<PoundlockJob> {
    const job = this.jobs.get(id);
    if (!job) throw new PoundlockError("job not found", 404);
    return this.publicJob(job);
  }

  async jobEvents(id: string): Promise<PoundlockEvent[]> {
    return this.events.get(id) ?? [];
  }

  async cancelJob(id: string): Promise<{ cancel_requested: boolean }> {
    const job = this.jobs.get(id);
    if (!job) throw new PoundlockError("job not found", 404);
    job.cancel_requested = true;
    if (job.status === "running" || job.status === "submitted") {
      job.status = "cancelled";
    }
    return { cancel_requested: true };
  }

  private resultPayload(input: Pick<SubmitJobInput, "policy">) {
    return {
      patches: [{ root: "", base_revision: "snapshot", patch: SAMPLE_PATCH }],
      output: "worker completed",
      provenance: {
        model_profile_id: SAMPLE_MODEL.id,
        model: SAMPLE_MODEL.model_id,
        harness: "pi",
        harness_version: "1.0.0",
        verification: {
          status: input.policy?.verification?.commands?.length ? "passed" : "unverified",
          reason: "ok",
          commands: (input.policy?.verification?.commands ?? []).map((command) => ({
            command: command.command,
            exit_code: 0,
            output: "ok",
            error: null,
          })),
        },
      },
      cleanup: { status: "cleaned" },
    };
  }

  private publicJob(job: PoundlockJob & { requestHash: string }): PoundlockJob {
    const { requestHash: _ignored, ...rest } = job;
    return rest;
  }
}
