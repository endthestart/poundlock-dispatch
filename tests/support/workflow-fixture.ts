import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import type { WorkerPort, WorkerResult } from "@core/interactive-worker";
import { MemoryPoundlock } from "@core/memory-poundlock";
import {
  type ManagerPort,
  type ManagerTurnContext,
  ProjectOrchestrator,
  type ProposePlanInput,
} from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import type { ProjectPolicy, TaskRecord } from "@shared/types";

/** Deterministic Dispatch fixture: real store and orchestrator, fake manager/worker/Poundlock. */
export async function workflowFixture(options?: {
  prefix?: string;
  policy?: Partial<ProjectPolicy>;
  files?: Record<string, string>;
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), options?.prefix ?? "dispatch-workflow-")),
  );
  const folder = join(root, "project");
  await mkdir(folder);
  for (const [path, content] of Object.entries(options?.files ?? {}))
    await writeFile(join(folder, path), content);
  const store = new FileStore(join(root, "data"));
  await store.init();
  await store.saveConnection({
    url: "http://fixture",
    token: "fixture",
    roles: {
      manager: { profileId: "coding", profileName: "coding", source: "interactive" },
      interactive: { profileId: "coding", profileName: "coding", source: "interactive" },
    },
  });
  const backend = new MemoryPoundlock();
  backend.listInteractiveModels = async () => [
    {
      id: "coding",
      context_tokens: 32768,
      max_output_tokens: 4096,
      dataDestination: "operator_network",
      workload_class: "interactive-coding",
    },
  ];
  const project = await createFolderProject({ store, folder, policy: options?.policy });
  return { root, folder, store, backend, project };
}

export type WorkflowFixture = Awaited<ReturnType<typeof workflowFixture>>;

export function planTask(
  title: string,
  extra?: Partial<ProposePlanInput["tasks"][number]>,
): ProposePlanInput["tasks"][number] {
  return {
    title,
    objective: title,
    workerPrompt: title,
    acceptanceCriteria: `${title} done`,
    difficulty: "small",
    route: "interactive",
    ...extra,
  };
}

/**
 * A manager that proposes `tasks` once, then on review applies `decide` to
 * the first task awaiting review. Every turn is counted and the prompt kept.
 */
export function countingManager(
  store: FileStore,
  plan: { tasks: ProposePlanInput["tasks"]; environmentNeed?: "python"; downloads?: boolean },
  decide: (
    ctx: ManagerTurnContext,
    review: TaskRecord,
    tasks: TaskRecord[],
  ) => Promise<void> = async (ctx, review) => {
    await ctx.host.requestApplyResult(review.id);
  },
) {
  const turns: string[] = [];
  const manager: ManagerPort = {
    async runTurn(ctx) {
      turns.push(ctx.prompt);
      const tasks = await store.getTasks(ctx.project.id);
      if (!tasks.length) {
        await ctx.host.proposePlan({
          summary: "Do the work",
          acceptanceCriteria: ["Work is done"],
          environmentNeed: plan.environmentNeed,
          allowDependencyDownloads: plan.downloads,
          tasks: plan.tasks,
        });
        return { text: "Plan recorded", toolTrace: [{ name: "propose_plan", summary: "ok" }] };
      }
      const review = tasks.find((task) => task.status === "needs_review");
      if (review) await decide(ctx, review, tasks);
      else if (tasks.every((task) => task.status === "applied"))
        await ctx.host.markComplete("All accepted.");
      return { text: "Reviewed", toolTrace: [] };
    },
  };
  return { manager, turns };
}

export function passingResult(file: string): WorkerResult {
  return {
    output: "Done",
    changedFiles: [file],
    patch: `+${file}`,
    verification: {
      status: "passed",
      commands: [{ command: "node --test", exitCode: 0, output: "passed" }],
    },
  };
}

/** A worker that writes one file per run and records which task it ran. */
export function recordingWorker(
  result: (run: number, taskTitle: string) => WorkerResult | Promise<WorkerResult> = (run, title) =>
    passingResult(`${title.toLowerCase()}-${run}.txt`),
) {
  const runs: string[] = [];
  const worker: WorkerPort = {
    async run(ctx) {
      runs.push(ctx.task.title);
      const outcome = await result(runs.length, ctx.task.title);
      for (const file of outcome.changedFiles)
        await writeFile(join(ctx.cwd, file), `${ctx.task.title}\n`);
      return outcome;
    },
    async verify() {
      return {
        status: "passed",
        commands: [{ command: "node --test", exitCode: 0, output: "combined passed" }],
      };
    },
  };
  return { worker, runs };
}

/** For a test that never starts a task: it fails the test if it is asked to run. */
const idleWorker: WorkerPort = {
  async run() {
    throw new Error("No task should start in this test.");
  },
};

export function engineFor(
  f: WorkflowFixture,
  manager: ManagerPort,
  worker: WorkerPort = idleWorker,
  approvals: ApprovalBroker | null = new ApprovalBroker(),
  folderLock?: import("@core/folder-lock").FolderLockPort,
) {
  return new ProjectOrchestrator({
    hostCommands: hostCommandPort,
    store: f.store,
    clientFor: async () => f.backend,
    manager,
    worker,
    approvals: approvals ?? undefined,
    folderLock,
  });
}

/** Tick until nothing changes or `limit` polls elapse, waiting for local work each time. */
export async function settle(engine: ProjectOrchestrator, projectId: string, limit = 8) {
  for (let index = 0; index < limit; index += 1) {
    await engine.waitForLocal(projectId);
    await engine.tick(projectId);
  }
  await engine.waitForLocal(projectId);
}
