import { readFile, writeFile } from "node:fs/promises";
import { ApprovalBroker } from "@core/approval-broker";
import { DURABLE_NOTICE_ID, retireDurableWork } from "@core/durable-retirement";
import { DispatchHost, type HostDependencies } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import { roleMapReady } from "@shared/roles";
import type { AttemptRecord, PlanRecord, ProjectRecord, TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";
import {
  countingManager,
  engineFor,
  recordingWorker,
  settle,
  workflowFixture,
} from "./support/workflow-fixture";

/**
 * Projects saved by a version that routed tasks to Poundlock jobs. What they
 * hold is what that version wrote: the tests build it by hand.
 */

const JOB_PATCH = {
  root: "",
  baseRevision: "rev-0",
  patch: "diff --git a/job.txt b/job.txt\n+job\n",
  sha256: "abc",
};

function jobAttempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: "att_job",
    number: 1,
    idempotencyKey: "lockkeep:key",
    requestHash: "hash",
    execution: "durable",
    role: "durable",
    jobId: "job_1",
    profileId: "long-job",
    profileName: "Long job",
    harnessId: "pi",
    status: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    selectionReason: "Durable profile Long job.",
    ...over,
  };
}

function jobTask(title: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: `task_${title}`,
    title,
    objective: title,
    workerPrompt: title,
    acceptanceCriteria: "Done",
    dependsOn: [],
    difficulty: "small",
    contextNote: "",
    route: "durable" as never,
    status: "queued",
    repairCount: 0,
    attempts: [jobAttempt()],
    ...over,
  };
}

const approvedPlan: PlanRecord = {
  revision: 1,
  summary: "Build",
  acceptanceCriteria: ["Done"],
  authority: "Included files",
  approved: true,
  createdAt: "2026-10-01T00:00:00.000Z",
};

/** What the older version left on the project record while it waited on a job. */
async function saveLegacyProject(
  f: Awaited<ReturnType<typeof workflowFixture>>,
  tasks: TaskRecord[],
  patch: Record<string, unknown> = {},
): Promise<ProjectRecord> {
  const project = (await f.store.getProject(f.project.id))! as ProjectRecord &
    Record<string, unknown>;
  project.status = "running";
  project.planRevision = 1;
  project.dispatchAuthorized = true;
  project.durableControllerUrl = "http://fixture";
  project.durableConsentRevision = 1;
  // The walk-away grant, as it was written: named a controller and a job ceiling.
  project.unattended = {
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    planRevision: 1,
    policyKey: "policy-1",
    workflowId: "workflow-1",
    allow: { durableUpload: { controllerUrl: "http://fixture" } },
    maxDurableJobs: 5,
    maxManagerTurns: 20,
  };
  project.budget.jobsSubmitted = tasks.length;
  Object.assign(project.integration, { combinedJobId: "job_combined", combinedRequest: {} });
  Object.assign(project, patch);
  await f.store.saveProject(project);
  await f.store.savePlan(project.id, approvedPlan);
  await f.store.saveTasks(project.id, tasks);
  return project;
}

describe("a project saved while Poundlock jobs were routed automatically", () => {
  it("loads, and its unfinished durable task runs interactively when started again", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-" });
    await saveLegacyProject(f, [
      jobTask("Waiting"),
      jobTask("Accepted", {
        status: "applied",
        attempts: [
          jobAttempt({
            id: "att_done",
            status: "completed",
            result: { status: "completed", output: "", patches: [] },
          }),
        ],
      }),
    ]);
    await retireDurableWork(f.store, f.project.id);

    const tasks = await f.store.getTasks(f.project.id);
    expect(tasks.map((task) => task.route)).toEqual(["interactive", "interactive"]);
    const waiting = tasks[0];
    expect(waiting.status).toBe("ready");
    // The job is no longer followed: its attempt is history, not live work.
    expect(waiting.attempts[0]).toMatchObject({ status: "cancelled", execution: "durable" });
    expect(waiting.attempts[0].error).toContain("job_1");
    const project = (await f.store.getProject(f.project.id)) as ProjectRecord &
      Record<string, unknown>;
    expect(project.durableControllerUrl).toBeUndefined();
    expect(project.durableConsentRevision).toBeUndefined();
    expect(project).not.toHaveProperty("unattended");
    expect(project.integration).not.toHaveProperty("combinedJobId");
    expect(project.integration).not.toHaveProperty("combinedRequest");

    const { worker, runs } = recordingWorker();
    const engine = engineFor(f, countingManager(f.store, { tasks: [] }).manager, worker);
    await engine.start(f.project.id);
    await settle(engine, f.project.id);
    expect(runs).toEqual(["Waiting"]);
    expect(f.backend.submits).toBe(0);
    const ran = (await f.store.getTasks(f.project.id))[0];
    expect(ran.attempts.map((attempt) => attempt.execution)).toEqual(["durable", "interactive"]);
  });

  it("closes an attempt that was about to be sent, with no job to name", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-" });
    await saveLegacyProject(f, [
      jobTask("Unsent", { attempts: [jobAttempt({ status: "pending_submit", jobId: undefined })] }),
    ]);
    await retireDurableWork(f.store, f.project.id);
    const [task] = await f.store.getTasks(f.project.id);
    expect(task.attempts[0].status).toBe("cancelled");
    expect(task.attempts[0].error).toMatch(/never did/);
    expect(task.status).toBe("ready");
  });

  it("drops a durable escalation grant, which no interactive worker can use", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-" });
    const escalation = {
      profile: {
        profileId: "frontier-job",
        profileName: "Frontier job",
        source: "durable" as never,
      },
      policyKey: "k",
      planRevision: 1,
      destination: "external",
      reason: "r",
    };
    await saveLegacyProject(f, [
      jobTask("Escalated", { status: "ready", attempts: [], escalation }),
    ]);
    await retireDurableWork(f.store, f.project.id);
    const [task] = await f.store.getTasks(f.project.id);
    expect(task.escalation).toBeUndefined();
  });

  it("clears a pending question about jobs, and a stop from the job budget", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-" });
    await saveLegacyProject(f, [jobTask("Waiting", { status: "ready", attempts: [] })], {
      status: "needs_input",
      needsInput: {
        question: "Run as durable jobs?",
        askedAt: "2026-10-01T00:00:00.000Z",
        kind: "route_decision",
        choices: [
          { id: "run_durable", label: "Run as durable jobs" },
          { id: "wait", label: "Wait" },
        ],
      },
    });
    await retireDurableWork(f.store, f.project.id);
    let project = (await f.store.getProject(f.project.id))!;
    expect(project.needsInput).toBeUndefined();
    expect(project.status).toBe("paused");
    expect(project.pause?.cause).toBe("awaiting_resume");

    project.status = "failed";
    project.budget.stopReason =
      "The job budget for this run is exhausted. Remaining results are kept.";
    await f.store.saveProject(project);
    await retireDurableWork(f.store, f.project.id);
    project = (await f.store.getProject(f.project.id))!;
    expect(project.budget.stopReason).toBeUndefined();
    expect(project.status).toBe("paused");
  });

  it("says once that a result never reached the folder", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-" });
    const project = await saveLegacyProject(f, [
      jobTask("Accepted", {
        status: "applied",
        attempts: [
          jobAttempt({
            status: "completed",
            result: { status: "completed", output: "", patches: [JOB_PATCH] },
          }),
        ],
      }),
    ]);
    // Applied to the review workspace (head moved) and never copied back.
    project.source.baseRevision = "rev-0";
    project.integration.headRevision = "rev-1";
    await f.store.saveProject(project);

    await retireDurableWork(f.store, f.project.id);
    await retireDurableWork(f.store, f.project.id);

    const notices = (await f.store.getMessages(f.project.id)).filter(
      (message) => message.id === DURABLE_NOTICE_ID,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe("notice");
    expect(notices[0].text).toMatch(/never copied into your folder/);
    expect(notices[0].text).toMatch(/export them with the Dispatch you used before/);
  });

  it("names a finished job result nobody accepted, and runs that task again", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-" });
    await saveLegacyProject(f, [
      jobTask("Reviewed", {
        status: "needs_review",
        attempts: [
          jobAttempt({
            status: "completed",
            result: { status: "completed", output: "", patches: [JOB_PATCH] },
          }),
        ],
      }),
    ]);
    await retireDurableWork(f.store, f.project.id);
    const [task] = await f.store.getTasks(f.project.id);
    expect(task.status).toBe("ready");
    // The finished result stays as it was: it was never in flight.
    expect(task.attempts[0]).toMatchObject({ status: "completed" });
    const [notice] = (await f.store.getMessages(f.project.id)).filter(
      (message) => message.id === DURABLE_NOTICE_ID,
    );
    expect(notice.text).toContain("“Reviewed”");
  });

  it("leaves an interactive project alone and says nothing", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-" });
    const before = (await f.store.getProject(f.project.id))!;
    await retireDurableWork(f.store, f.project.id);
    expect(await f.store.getProject(f.project.id)).toEqual(before);
    expect(await f.store.getMessages(f.project.id)).toEqual([]);
  });

  it("is done by the host before it recovers projects, so a restart resumes them as interactive", async () => {
    const f = await workflowFixture({ prefix: "dispatch-retire-host-" });
    await saveLegacyProject(f, [jobTask("Waiting")]);
    const { worker } = recordingWorker();
    const deps: HostDependencies = {
      worker: () => worker,
      managerProvider: () => ({
        get: async () => countingManager(f.store, { tasks: [] }).manager,
        reset: async () => undefined,
        abort: () => undefined,
        clear: () => undefined,
      }),
      orchestrator: (dependencies) =>
        new ProjectOrchestrator({
          hostCommands: hostCommandPort,
          ...dependencies,
          clientFor: async () => f.backend,
        }),
      lifecycle: (dependencies) => new ProjectLifecycle(dependencies),
    };
    const host = new DispatchHost(
      { dataRoot: f.store.layout.root },
      f.store,
      new ApprovalBroker(),
      deps,
    );
    await host.start();
    host.stopPolling();
    const [task] = await f.store.getTasks(f.project.id);
    expect(task).toMatchObject({ route: "interactive", status: "ready" });
    const project = (await f.store.getProject(f.project.id))!;
    // Recovery paused the interrupted run for the owner, as it does for any project.
    expect(project.status).toBe("paused");
    expect(project).not.toHaveProperty("unattended");
  });
});

describe("connection settings saved while a job profile could be bound", () => {
  const binding = (profileId: string, source: "interactive" | "durable") => ({
    profileId,
    profileName: profileId,
    source,
  });

  async function storeSaved(saved: Record<string, unknown>) {
    const store = new FileStore(await tempDir("dispatch-retire-connection-"));
    await store.init();
    await writeFile(
      store.layout.config.connection,
      JSON.stringify({ url: "http://fixture", ...saved }),
    );
    return store;
  }

  it("loads without the durable role, and keeps the roles that still run work", async () => {
    const store = await storeSaved({
      roles: {
        manager: binding("manager-id", "interactive"),
        interactive: binding("worker-id", "interactive"),
        durable: binding("job-id", "durable"),
      },
    });
    const connection = await store.getConnection();
    expect(Object.keys(connection.roles).sort()).toEqual(["interactive", "manager"]);
    expect(roleMapReady(connection.roles)).toBe(true);
    expect((await store.getConnectionPublic()).roles).toEqual(connection.roles);
  });

  it("drops a ladder rung for a job profile and keeps the others in order", async () => {
    const store = await storeSaved({
      roles: {},
      escalation: {
        mode: "standing",
        maxTransitionsPerRun: 4,
        profiles: [
          binding("first", "interactive"),
          binding("a-job", "durable"),
          binding("second", "interactive"),
        ],
      },
    });
    const { escalation } = await store.getConnection();
    expect(escalation?.profiles.map((profile) => profile.profileId)).toEqual(["first", "second"]);
    expect(escalation).toMatchObject({ mode: "standing", maxTransitionsPerRun: 4 });
  });

  it("writes them out the next time settings are saved", async () => {
    const store = await storeSaved({
      roles: { durable: binding("job-id", "durable") },
      escalation: { mode: "ask", maxTransitionsPerRun: 3, profiles: [binding("a-job", "durable")] },
    });
    await store.saveConnection(await store.getConnection());
    const written = JSON.parse(await readFile(store.layout.config.connection, "utf8"));
    expect(written.roles).toEqual({});
    expect(written.escalation.profiles).toEqual([]);
  });

  it("leaves a connection that never bound a job exactly as it was", async () => {
    const saved = {
      roles: { manager: binding("manager-id", "interactive") },
      escalation: { mode: "ask", maxTransitionsPerRun: 3, profiles: [binding("a", "interactive")] },
    };
    const store = await storeSaved(saved);
    const connection = await store.getConnection();
    expect(connection.roles).toEqual(saved.roles);
    expect(connection.escalation).toEqual(saved.escalation);
  });
});
