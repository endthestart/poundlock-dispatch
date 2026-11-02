/**
 * The host layer both front ends share, driven with no Electron and no
 * terminal — which is the point: if these behaviours needed a window, a second
 * front end would have had to reimplement them.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, type AutoRunFile, projectKey, writeRunFile } from "@core/auto/runs";
import { FolderLock } from "@core/folder-lock";
import { DispatchHost, type HostDependencies, type HostFacilities } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { hostCommandPort } from "@runtime/host-command";
import { DEFAULT_AUTO_LIMITS } from "@shared/auto-run";
import type { AppStateView, ConnectionAddress } from "@shared/types";
import { describe, expect, it } from "vitest";
import { fakePoundlock } from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";
import {
  countingManager,
  planTask,
  recordingWorker,
  workflowFixture,
} from "./support/workflow-fixture";

/** A host wired to the fixture's in-memory Poundlock and a scripted manager. */
async function hostFixture(options?: {
  facilities?: Partial<HostFacilities>;
  /** Replaces the scripted planner when a test cares about how a turn behaves, not what it plans. */
  manager?: import("@core/orchestration").ManagerPort;
  folderLock?: FolderLock;
}) {
  const fixture = await workflowFixture({ prefix: "dispatch-host-" });
  const counting = countingManager(fixture.store, { tasks: [planTask("Task one")] });
  const manager = options?.manager ?? counting.manager;
  const turns = counting.turns;
  const { worker, runs } = recordingWorker();
  const approvals = new ApprovalBroker(() => {
    void host.emitState();
  });
  const deps: HostDependencies = {
    worker: () => worker,
    managerProvider: () => ({
      get: async () => manager,
      reset: async () => undefined,
      abort: () => undefined,
      clear: () => undefined,
    }),
    orchestrator: (dependencies) =>
      new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        ...dependencies,
        clientFor: async () => fixture.backend,
      }),
    lifecycle: (dependencies) => new ProjectLifecycle(dependencies),
    ...(options?.folderLock ? { folderLock: options.folderLock } : {}),
  };
  const host = new DispatchHost(
    { dataRoot: fixture.store.layout.root, ...options?.facilities },
    fixture.store,
    approvals,
    deps,
  );
  return { fixture, host, approvals, turns, runs };
}

/** Every state the host pushed, so a test can assert on the stream, not a poll. */
function collect(host: DispatchHost) {
  const seen: AppStateView[] = [];
  const stop = host.onState((state) => seen.push(state));
  return { seen, stop };
}

describe("DispatchHost state", () => {
  it("assembles the same snapshot the renderer already consumes", async () => {
    const { fixture, host } = await hostFixture();
    await host.selectProject(fixture.project.id);
    const state = await host.getState();
    expect(state.selectedProjectId).toBe(fixture.project.id);
    expect(state.snapshot?.project.id).toBe(fixture.project.id);
    expect(state.projects.map((project) => project.id)).toContain(fixture.project.id);
    expect(state.connection.url).toBe("http://fixture");
    expect(state.busy).toBe(false);
    expect(state.approvals).toEqual([]);
  });

  it("pushes to every listener on a mutation, and stops on unsubscribe", async () => {
    const { fixture, host } = await hostFixture();
    const first = collect(host);
    const second = collect(host);
    await host.emitState();
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
    first.stop();
    await host.selectProject(fixture.project.id);
    await host.emitState();
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(2);
    expect(second.seen.at(-1)?.selectedProjectId).toBe(fixture.project.id);
  });

  it("signals a project needs the user once it starts needing them, not on every push", async () => {
    // notifyNeedsYou is the one signal each host renders its own way — a dock
    // badge, a terminal bell. The host decides *when*, so both agree on it.
    const counts: number[] = [];
    const { fixture, host } = await hostFixture({
      facilities: { notifyNeedsYou: (count) => counts.push(count) },
    });
    await host.emitState();
    await host.emitState();
    expect(counts).toEqual([]);

    const project = (await fixture.store.getProject(fixture.project.id))!;
    project.status = "needs_input";
    project.needsInput = { question: "Which database?", askedAt: new Date().toISOString() };
    await fixture.store.saveProject(project);
    await host.emitState();
    await host.emitState();
    expect(counts).toEqual([1]);
  });

  it("tells the host when the count falls, so a badge set once can clear", async () => {
    // The alert fires on a rise; the count itself is a standing figure. Only
    // reporting rises meant deciding the last card left the dock badge on for
    // the rest of the session.
    const seen: Array<[number, boolean]> = [];
    const { fixture, host } = await hostFixture({
      facilities: { notifyNeedsYou: (count, _ui, alert) => seen.push([count, alert]) },
    });
    const project = (await fixture.store.getProject(fixture.project.id))!;
    project.status = "needs_input";
    project.needsInput = { question: "Which database?", askedAt: new Date().toISOString() };
    await fixture.store.saveProject(project);
    await host.emitState();
    expect(seen).toEqual([[1, true]]);

    project.status = "running";
    project.needsInput = undefined;
    await fixture.store.saveProject(project);
    await host.emitState();
    expect(seen).toEqual([
      [1, true],
      [0, false],
    ]);
  });
});

describe("DispatchHost lifecycle", () => {
  it("stops advancing work when a view closes without tearing the host down", async () => {
    // ADR 001: closing a view differs from exiting its host. On macOS the app
    // outlives its last window, and a shutdown here paused every project,
    // aborted its workers and dropped the folder lock — with nothing to undo
    // it when the window came back.
    const { fixture, host } = await hostFixture();
    await host.selectProject(fixture.project.id);
    await host.start();

    host.stopPolling();
    host.resumePolling();
    host.resumePolling(); // idempotent: never a second timer

    const project = await fixture.store.getProject(fixture.project.id);
    expect(project?.status).not.toBe("paused");
    await host.shutdown();
  });
});

describe("DispatchHost action queue", () => {
  it("serializes actions for one project and keeps other projects moving", async () => {
    const { fixture, host } = await hostFixture();
    const order: string[] = [];
    const slow = host.sendMessage("first", { projectId: fixture.project.id });
    const fast = host.sendMessage("second", { projectId: fixture.project.id });
    await Promise.all([
      slow.then(() => order.push("first")),
      fast.then(() => order.push("second")),
    ]);
    expect(order).toEqual(["first", "second"]);
  });

  it("takes a message during a manager turn at once, for the turn after it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fixture, host } = await hostFixture({
      manager: {
        async runTurn() {
          await gate;
          return { text: "Done", toolTrace: [] };
        },
      },
    });
    await host.selectProject(fixture.project.id);
    const first = host.sendMessage("first", { projectId: fixture.project.id });
    await expect.poll(async () => (await host.getState()).managerTurning).toBe(true);
    // Resolves while the first turn is still running, instead of queueing behind it.
    await host.sendMessage("second", { projectId: fixture.project.id });
    expect((await fixture.store.getProject(fixture.project.id))?.unreadOwnerMessages).toHaveLength(
      1,
    );
    release();
    await first;
    expect((await host.getState()).managerTurning).toBe(false);
  });

  it("reports busy while an action runs and clears it afterwards", async () => {
    const { fixture, host } = await hostFixture();
    await host.selectProject(fixture.project.id);
    const { seen } = collect(host);
    await host.sendMessage("hello", { projectId: fixture.project.id });
    expect(seen.some((state) => state.busy)).toBe(true);
    expect((await host.getState()).busy).toBe(false);
  });

  it("binds an action to the project chosen when it arrived, not the one now selected", async () => {
    const { fixture, host } = await hostFixture();
    await host.selectProject(fixture.project.id);
    const pending = host.sendMessage("for the original project", {
      projectId: fixture.project.id,
    });
    await host.selectProject("some-other-project");
    await pending;
    const messages = await fixture.store.getMessages(fixture.project.id);
    expect(messages.some((message) => message.text === "for the original project")).toBe(true);
  });

  it("rejects an action bound to a run that has been replaced", async () => {
    const { fixture, host } = await hostFixture();
    await expect(
      host.sendMessage("stale", { projectId: fixture.project.id, workflowId: "replaced" }),
    ).rejects.toThrow();
  });

  it("refuses to act with no project open rather than guessing one", async () => {
    const { host } = await hostFixture();
    await expect(host.sendMessage("nothing is open")).rejects.toThrow(/Open a project first/);
  });
});

describe("DispatchHost connection", () => {
  it("saves only the address and token: roles come only from Save models, which checks them", async () => {
    // The wizard's Test connection saved its unconfirmed suggestions, an external worker among them, as the roles (30 Oct).
    const { fixture, host } = await hostFixture();
    const before = await fixture.store.getConnection();
    const sent = {
      url: before.url,
      token: before.token,
      roles: { interactive: { profileId: "external-frontier", profileName: "external-frontier" } },
    };
    // The renderer's IPC carries whatever it sends, whatever the type says.
    await host.saveConnection(sent as unknown as ConnectionAddress);
    expect((await fixture.store.getConnection()).roles).toEqual(before.roles);
  });
});

describe("DispatchHost folder lock", () => {
  it("takes the folder on its next poll once the client driving it has exited", async () => {
    // UX review, 30 Oct: a client opened while another drove the folder watched
    // nobody for the rest of its session after that one crashed.
    const locks = await tempDir("host-locks-");
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const { fixture, host } = await hostFixture({
      folderLock: new FolderLock(locks, { hostApp: "gui", dataRoot: "/data/gui" }),
    });
    try {
      const theirs = new FolderLock(locks, { hostApp: "tui", dataRoot: "/data/tui" });
      await theirs.acquire(fixture.folder);
      const file = (await readdir(locks)).find((name) => name.endsWith(".json"))!;
      const held = JSON.parse(await readFile(join(locks, file), "utf8"));
      await writeFile(join(locks, file), JSON.stringify({ ...held, pid: other.pid }));
      await host.selectProject(fixture.project.id);
      expect((await host.getState()).watching?.heldBy).toBeDefined();
      other.kill("SIGKILL");
      await new Promise((resolve) => other.once("exit", resolve));
      host.resumePolling();
      await expect
        .poll(async () => (await host.getState()).watching, { timeout: 10_000 })
        .toBeUndefined();
    } finally {
      other.kill("SIGKILL");
      host.stopPolling();
    }
  });
});

describe("DispatchHost decisions", () => {
  it("records every approval decision in the transcript both front ends read", async () => {
    const { fixture, host, approvals } = await hostFixture();
    const decision = approvals.request({
      projectId: fixture.project.id,
      projectName: fixture.project.name,
      planRevision: fixture.project.planRevision,
      kind: "bash",
      action: "npm test",
      reason: "run the tests",
      cwd: fixture.folder,
    });
    const pending = approvals.list()[0];
    expect(pending).toBeTruthy();
    await host.decideApproval(pending.id, "deny");
    expect(await decision).toBe(false);
    const messages = await fixture.store.getMessages(fixture.project.id);
    expect(messages.at(-1)?.text).toBe("Denied: npm test");
    expect(messages.at(-1)?.role).toBe("system");
  });

  it("saves an always decision as an exact project exception, not a blanket one", async () => {
    const { fixture, host, approvals } = await hostFixture();
    void approvals.request({
      projectId: fixture.project.id,
      projectName: fixture.project.name,
      planRevision: fixture.project.planRevision,
      kind: "bash",
      action: "npm test",
      reason: "run the tests",
      cwd: fixture.folder,
    });
    await host.decideApproval(approvals.list()[0].id, "always");
    const saved = (await fixture.store.getPermissions()).grants?.[fixture.project.id] ?? [];
    expect(saved).toEqual([{ kind: "bash", action: "npm test", cwd: fixture.folder }]);
    const messages = await fixture.store.getMessages(fixture.project.id);
    expect(messages.at(-1)?.text).toMatch(/exact project exception/);
  });

  it("refuses a decision it does not understand", async () => {
    const { host } = await hostFixture();
    await expect(host.decideApproval("any", "maybe")).rejects.toThrow(/Unknown approval decision/);
  });
});

describe("DispatchHost facilities", () => {
  it("does not invent a file grant when the host cannot ask for one", async () => {
    // A front end with no file picker simply grants nothing; it must not crash
    // and must not silently widen what the manager may read.
    const { fixture, host } = await hostFixture();
    await host.grantReadFile(fixture.project.id);
    const project = await fixture.store.getProject(fixture.project.id);
    expect(project?.policy.readGrants ?? []).toEqual([]);
  });

  it("records the exact file a host picked, resolved through any symlink", async () => {
    const { fixture, host } = await hostFixture({
      facilities: { chooseFile: async () => `${fixture.folder}/notes.txt` },
    });
    await (await import("node:fs/promises")).writeFile(`${fixture.folder}/notes.txt`, "hello");
    await host.grantReadFile(fixture.project.id);
    const project = await fixture.store.getProject(fixture.project.id);
    expect(project?.policy.readGrants).toEqual([`${fixture.folder}/notes.txt`]);
  });

  it("records a typed path the same way, and refuses one that does not exist", async () => {
    const { fixture, host } = await hostFixture();
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${fixture.folder}/.env`, "KEY=1");
    await fs.symlink(`${fixture.folder}/.env`, `${fixture.folder}/env-link`);
    await host.grantReadFile(fixture.project.id, `${fixture.folder}/env-link`);
    const project = await fixture.store.getProject(fixture.project.id);
    expect(project?.policy.readGrants).toEqual([await fs.realpath(`${fixture.folder}/.env`)]);
    await expect(
      host.grantReadFile(fixture.project.id, `${fixture.folder}/missing`),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("DispatchHost lifecycle", () => {
  it("pauses work that cannot safely continue across a restart", async () => {
    const { fixture, host } = await hostFixture();
    const project = await fixture.store.getProject(fixture.project.id);
    project!.status = "running";
    await fixture.store.saveProject(project!);
    await host.start();
    await host.shutdown();
    expect((await fixture.store.getProject(fixture.project.id))?.status).toBe("paused");
  });

  it("stops polling once shut down", async () => {
    const { host } = await hostFixture();
    await host.start();
    await host.shutdown();
    const before = await host.getState();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await host.getState()).projects.length).toBe(before.projects.length);
  });
});

describe("DispatchHost manager draft", () => {
  /** Comfortably past the host's own coalescing window, so the timer has fired. */
  const DRAFT_SETTLE_MS = 200;

  /** A manager that says something over several deltas before its turn ends. */
  function streamingManager(options?: { throw?: boolean }) {
    const manager: import("@core/orchestration").ManagerPort = {
      async runTurn(ctx) {
        let said = "";
        for (const delta of ["Reading ", "the project ", "files."]) {
          said += delta;
          ctx.onDraft?.(said);
        }
        // Long enough for the host's coalescing timer to fire, the way a real
        // turn's think time is.
        await new Promise((resolve) => setTimeout(resolve, DRAFT_SETTLE_MS));
        if (options?.throw) {
          ctx.onDraft?.(undefined);
          throw new Error("The manager failed mid-turn.");
        }
        ctx.onDraft?.(undefined);
        return { text: said, toolTrace: [] };
      },
    };
    return manager;
  }

  it("publishes what the manager is saying before the turn ends", async () => {
    const { fixture, host } = await hostFixture({ manager: streamingManager() });
    await host.selectProject(fixture.project.id);
    const { seen } = collect(host);
    await host.sendMessage("hello", { projectId: fixture.project.id });
    // The whole point: something was readable while the turn was still open.
    // Before drafts existed every one of these was undefined.
    expect(seen.some((state) => state.managerDraft === "Reading the project files.")).toBe(true);
  });

  it("drops the draft once the finished message exists, so it is not shown twice", async () => {
    const { fixture, host } = await hostFixture({ manager: streamingManager() });
    await host.selectProject(fixture.project.id);
    await host.sendMessage("hello", { projectId: fixture.project.id });
    const state = await host.getState();
    expect(state.managerDraft).toBeUndefined();
    expect(state.snapshot?.messages.at(-1)?.text).toBe("Reading the project files.");
  });

  it("drops the draft when the turn fails, so a dead turn does not look live", async () => {
    const { fixture, host } = await hostFixture({ manager: streamingManager({ throw: true }) });
    await host.selectProject(fixture.project.id);
    await host.sendMessage("hello", { projectId: fixture.project.id }).catch(() => undefined);
    expect((await host.getState()).managerDraft).toBeUndefined();
  });

  it("shows no draft while no project is selected", async () => {
    // The draft is held per project. A turn running in one project must not
    // appear under whichever project the user happens to be looking at.
    const { fixture, host } = await hostFixture({ manager: streamingManager() });
    const { seen } = collect(host);
    await host.sendMessage("hello", { projectId: fixture.project.id });
    expect(seen.every((state) => state.managerDraft === undefined)).toBe(true);
  });
});

describe("DispatchHost reasoning and model settings", () => {
  /** A catalog with the fixture's `coding` manager verified for none and high. */
  function served(host: DispatchHost, permissions = ["models:read", "inference:invoke"]) {
    Object.defineProperty(host.discovery, "probe", {
      configurable: true,
      value: {
        ok: true,
        permissions,
        interactiveModels: [
          {
            id: "coding",
            profileId: "coding",
            context_tokens: 32768,
            max_output_tokens: 4096,
            dataDestination: "operator_network",
            workload_class: "interactive-coding",
            reasoningLevels: ["none", "high"],
          },
          {
            id: "frontier",
            profileId: "frontier",
            context_tokens: 200000,
            max_output_tokens: 8192,
            dataDestination: "external",
            workload_class: "interactive-coding",
          },
        ],
        durableModels: [],
      },
    });
  }

  it("keeps a conversation's reasoning only when the manager's profile offers it", async () => {
    const { fixture, host } = await hostFixture();
    served(host);
    const id = fixture.project.id;
    await host.setConversationReasoning(id, "high");
    expect((await fixture.store.getProject(id))?.reasoningOverride).toBe("high");
    await expect(host.setConversationReasoning(id, "low")).rejects.toThrow(
      /not verified for coding.*Model default, None, High/,
    );
    await expect(host.setConversationReasoning(id, "max" as never)).rejects.toThrow(
      /not recognised/,
    );
    expect((await fixture.store.getProject(id))?.reasoningOverride).toBe("high");
    await host.setConversationReasoning(id, undefined);
    expect((await fixture.store.getProject(id))?.reasoningOverride).toBeUndefined();
  });

  it("refuses an external project manager or worker for a token without external access", async () => {
    const { fixture, host } = await hostFixture();
    served(host);
    const project = (await fixture.store.getProject(fixture.project.id))!;
    await expect(
      host.updateProjectPolicy(project.id, { ...project.policy, managerModel: "frontier" }),
    ).rejects.toThrow(/cannot use an external manager/);
    expect((await fixture.store.getProject(project.id))?.policy.managerModel).toBe("");
    served(host, ["models:read", "inference:invoke", "external:invoke"]);
    await host.updateProjectPolicy(project.id, { ...project.policy, managerModel: "frontier" });
    expect((await fixture.store.getProject(project.id))?.policy.managerModel).toBe("frontier");
    served(host);
    await expect(
      host.updateProjectPolicy(project.id, { ...project.policy, workerModel: "frontier" }),
    ).rejects.toThrow(/cannot use an external worker/);
    await host.updateProjectPolicy(project.id, { ...project.policy, workerModel: "coding" });
    expect((await fixture.store.getProject(project.id))?.policy.workerModel).toBe("coding");
  });

  it("keeps the stored folders when a policy update sends others", async () => {
    const { fixture, host } = await hostFixture();
    const project = (await fixture.store.getProject(fixture.project.id))!;
    const stored = [
      {
        path: "/checked/docs",
        mode: "read" as const,
        addedAt: "now",
        grantedBy: "config" as const,
      },
    ];
    await fixture.store.saveProject({ ...project, policy: { ...project.policy, roots: stored } });
    await host.updateProjectPolicy(project.id, {
      ...project.policy,
      roots: [
        { path: "/Users/someone", mode: "write", addedAt: "now", grantedBy: "config" },
        { path: "../../..", mode: "write", addedAt: "now", grantedBy: "config" },
      ],
    });
    expect((await fixture.store.getProject(project.id))?.policy.roots).toEqual(stored);
  });

  it("tests a connection without choosing the owner's models", async () => {
    // A fresh connect bound the first listed models and recorded
    // destination approvals nobody gave. The wizard suggests; only Save binds.
    const server = await fakePoundlock({ respond: () => ({ text: "unused" }) });
    try {
      const { fixture, host } = await hostFixture();
      const connection = await fixture.store.getConnection();
      await fixture.store.saveConnection({
        ...connection,
        url: server.url,
        token: server.token,
        roles: {},
      });
      const state = await host.testConnection();
      expect(state.probe?.ok, `${state.probe?.error} ${state.probe?.hint}`).toBe(true);
      expect((await fixture.store.getConnection()).roles).toEqual({});
    } finally {
      await server.close();
    }
  });

  it("saving a profile's destination keeps its other saved settings", async () => {
    const { fixture, host } = await hostFixture();
    const connection = await fixture.store.getConnection();
    await fixture.store.saveConnection({
      ...connection,
      profiles: { coding: { approvedDestination: "external", note: "kept" } as never },
    });
    await host.saveProfile("coding", { approvedDestination: "operator_network" });
    expect((await fixture.store.getConnection()).profiles?.coding).toEqual({
      approvedDestination: "operator_network",
      note: "kept",
    });
  });
});

describe("Autopilot in the app (ADR 016)", () => {
  async function autopilotFixture(checkRunner: () => Promise<void> = async () => undefined) {
    const paths = new AutoPaths(await realpath(await tempDir("host-autopilot-")));
    const spawned: string[] = [];
    const ctx = await hostFixture({
      facilities: {
        autopilot: { paths, checkRunner, spawnRunner: (runDir) => void spawned.push(runDir) },
      },
    });
    return { ...ctx, paths, spawned };
  }

  /** A run of the fixture's folder, held by a live process that names it, as a runner does. */
  async function liveRun(paths: AutoPaths, folder: string) {
    const runId = "auto-20261014-120000-abcd";
    const runDir = paths.runDir(runId);
    await mkdir(runDir, { recursive: true });
    await writeRunFile(runDir, {
      version: 1,
      runId,
      createdAt: new Date().toISOString(),
      source: folder,
      projectKey: projectKey(await realpath(folder)),
      baseCommit: "0".repeat(40),
      branch: `auto/${runId}`,
      mirror: join(paths.mirrors, "m.git"),
      cases: [
        { id: "T1", title: "Task one", objective: "o", acceptanceCriteria: "a", dependsOn: [] },
      ],
      image: "toolchain:test",
      model: "coding",
      limits: DEFAULT_AUTO_LIMITS,
    } as unknown as AutoRunFile);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", runDir], {
      stdio: "ignore",
    });
    await writeFile(join(runDir, "runner.pid"), String(holder.pid));
    return { runDir, stop: () => holder.kill("SIGKILL") };
  }

  it("shows the folder's run, keeps interactive work off it, and stops it through its inbox", async () => {
    const { fixture, host, paths } = await autopilotFixture();
    const run = await liveRun(paths, fixture.folder);
    try {
      await host.selectProject(fixture.project.id);
      const state = await host.getState();
      expect(state.autopilotAvailable).toBe(true);
      expect(state.autopilot).toMatchObject({
        phase: "preparing",
        cases: [{ id: "T1", stage: "pending" }],
        image: "toolchain:test",
      });
      await expect(host.startRun()).rejects.toThrow(/Autopilot is building this project/);
      // A message goes to the run's inbox, not to a manager turn.
      await host.sendMessage("Use larger thumbnails");
      expect(await new AutoLedger(run.runDir).readInbox()).toMatchObject([
        { cmd: "message", text: "Use larger thumbnails" },
      ]);
      const said = await fixture.store.getMessages(fixture.project.id);
      expect(said.at(-1)?.text).toContain("Sent to Autopilot");
      const stopped = await host.autopilotStop("now");
      expect(stopped.notice?.text).toMatch(/stopping now/);
      expect((await new AutoLedger(run.runDir).readInbox()).at(-1)).toMatchObject({
        cmd: "stop_now",
      });
      // An interrupted run still holds the project: a message waits for its resume.
      run.stop();
      await expect.poll(async () => (await host.getState()).autopilot?.phase).toBe("interrupted");
      await host.sendMessage("Thumbnails at 256 px");
      expect((await new AutoLedger(run.runDir).readInbox()).at(-1)).toMatchObject({
        cmd: "message",
        text: "Thumbnails at 256 px",
      });
      expect((await fixture.store.getMessages(fixture.project.id)).at(-1)?.text).toContain(
        "the run reads it when you resume",
      );
    } finally {
      run.stop();
    }
  });

  it("sends the owner's answer to a run that ended waiting for it, and a stopped run's words to the manager", async () => {
    // UX review, 30 Oct: a blocked run's card said "Needs you", but the composer
    // sent the answer to a manager turn, and the resumed run never read it.
    const { fixture, host, paths } = await autopilotFixture();
    const run = await liveRun(paths, fixture.folder);
    run.stop();
    await rm(join(run.runDir, "runner.pid"));
    const ledger = new AutoLedger(run.runDir);
    await ledger.append({
      type: "run_ended",
      outcome: "blocked_for_input",
      reason: "A task needs the owner's answer before work can go on.",
    });
    await host.selectProject(fixture.project.id);
    await expect.poll(async () => (await host.getState()).autopilot?.phase).toBe("ended");
    await host.sendMessage("Put the rating control under the loupe");
    expect((await ledger.readInbox()).at(-1)).toMatchObject({
      cmd: "message",
      text: "Put the rating control under the loupe",
    });
    await ledger.append({
      type: "run_ended",
      outcome: "cancelled_after_checkpoint",
      reason: "stopped by the owner",
    });
    await host.sendMessage("Let's change the plan");
    expect((await ledger.readInbox()).at(-1)?.text).toBe("Put the rating control under the loupe");
  });

  it("leaves the plan unapproved when the start is refused before it has a run", async () => {
    // A TUI start refused for an external worker had already approved the
    // plan, and the screen said approved work was ready.
    const { fixture, host, spawned } = await autopilotFixture();
    await host.selectProject(fixture.project.id);
    await host.sendMessage("build it");
    await expect
      .poll(async () => Boolean(await fixture.store.getPlan(fixture.project.id)))
      .toBe(true);
    await expect(host.autopilotStart({ image: "toolchain:test" })).rejects.toThrow();
    expect((await fixture.store.getPlan(fixture.project.id))?.approved).toBeFalsy();
    expect(spawned).toEqual([]);
  });

  it("changes nothing when the runner command cannot be used", async () => {
    const { fixture, host, spawned } = await autopilotFixture(async () => {
      throw new Error("The terminal client is 0.2.40; this app is 0.2.41.");
    });
    await host.selectProject(fixture.project.id);
    await expect(host.autopilotStart({ image: "toolchain:test" })).rejects.toThrow(/0\.2\.40/);
    expect((await fixture.store.getPlan(fixture.project.id))?.approved).toBeFalsy();
    expect(spawned).toEqual([]);
  });
});
