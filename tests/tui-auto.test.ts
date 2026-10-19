/**
 * `/auto` in the terminal client: the card follows the folder's newest run from
 * its files, says the work is verified and not reviewed, and the commands act
 * on that run. The runner is never run inside the screen.
 */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { ApprovalBroker } from "@core/approval-broker";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, type AutoRunFile, projectKey, writeRunFile } from "@core/auto/runs";
import { DispatchHost, type HostDependencies } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { hostCommandPort } from "@runtime/host-command";
import { DEFAULT_AUTO_LIMITS } from "@shared/auto-run";
import { TuiApp } from "@tui/app";
import { describe, expect, it, vi } from "vitest";
import { fakeDocker } from "./support/fake-docker";
import { tempDir } from "./support/temp-dir";
import {
  countingManager,
  planTask,
  recordingWorker,
  workflowFixture,
} from "./support/workflow-fixture";

function stubTui() {
  return {
    terminal: { rows: 40, columns: 100 },
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
    showOverlay: () => ({
      hide: () => undefined,
      setHidden: () => undefined,
      isHidden: () => true,
    }),
    start: () => undefined,
    stop: () => undefined,
    requestRender: () => undefined,
    addInputListener: () => () => undefined,
    removeInputListener: () => undefined,
    onTerminalColorSchemeChange: () => () => undefined,
    setTerminalColorSchemeNotifications: () => undefined,
  };
}

async function setup() {
  const fixture = await workflowFixture({ prefix: "tui-auto-" });
  const { manager } = countingManager(fixture.store, { tasks: [planTask("Task one")] });
  const { worker } = recordingWorker();
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
  };
  const host = new DispatchHost(
    { dataRoot: fixture.store.layout.root },
    fixture.store,
    approvals,
    deps,
  );
  await host.selectProject(fixture.project.id);
  const docker = await fakeDocker();
  const paths = new AutoPaths(await tempDir("tui-auto-data-"));
  const app = new TuiApp(
    host,
    stubTui() as unknown as ConstructorParameters<typeof TuiApp>[1],
    vi.fn(),
    undefined,
    {
      paths,
      connection: async () => ({ url: "", token: "", roles: {}, profiles: {} }),
      project: async () => undefined,
      entry: "unused",
      docker: docker.docker,
      dockerEnv: docker.env,
      home: await tempDir("tui-auto-home-"),
    },
  );
  await app.start();
  const source = await realpath(fixture.folder);
  const runId = "auto-20260929-2200-abcd";
  const runDir = paths.runDir(runId);
  await mkdir(runDir, { recursive: true });
  const run: AutoRunFile = {
    version: 1,
    runId,
    createdAt: "2026-09-29T22:00:00.000Z",
    source,
    projectKey: projectKey(source),
    baseCommit: "b".repeat(40),
    branch: `auto/${runId}`,
    mirror: paths.mirrorFor(projectKey(source)),
    runsRoot: paths.runs,
    worktree: `${runDir}/work`,
    gitDir: "",
    cases: [
      { id: "C1", title: "one", objective: "o", acceptanceCriteria: "a", dependsOn: [] },
      { id: "C2", title: "two", objective: "o", acceptanceCriteria: "a", dependsOn: ["C1"] },
    ],
    limits: DEFAULT_AUTO_LIMITS,
    scope: {},
    checks: ["npm test"],
    prepare: [],
    allowDependencyDownloads: false,
    model: "orion-qwen3.8-27b-mtp",
    image: "node:22-slim",
    container: `dispatch-${runId}`,
  };
  await writeRunFile(runDir, run);
  const ledger = new AutoLedger(runDir);
  await ledger.append({
    type: "run_started",
    runId,
    cases: run.cases,
    limits: run.limits,
    supervision: "detached",
    baseCommit: run.baseCommit,
    model: run.model,
    isolation: "a container (node:22-slim), no network",
  });
  await ledger.append({ type: "preflight", phase: "checks", passed: true, commands: [] });
  await ledger.append({ type: "case_accepted", caseId: "C1" });
  await mkdir(paths.locks, { recursive: true });
  await writeFile(paths.lockFor(projectKey(source)), runId);
  const screen = () => app.renderForTest(100).map(stripTerminalSequences).join("\n");
  const notice = async () => (await host.getState()).notice?.text ?? "";
  return { app, host, fixture, paths, docker, ledger, run, runDir, screen, notice };
}

describe("/auto in the terminal client", () => {
  it("shows the folder's run as verified, not reviewed, and hides and shows it again", async () => {
    const env = await setup();
    await env.app.submitForTest("/auto watch");
    const screen = env.screen();
    expect(screen).toContain("Auto run · verified, not reviewed");
    expect(screen).toContain("Cases 1/2 verified, not reviewed");
    expect(screen).toContain("orion-qwen3.8-27b-mtp");
    expect(screen).toContain("The runner is not running");
    expect(screen).toContain("/auto stop");
    await env.app.submitForTest("/auto hide");
    expect(env.screen()).not.toContain("Auto run · verified");
    await env.app.submitForTest("/auto watch");
    expect(env.screen()).toContain("Auto run · verified");
    await env.app.stop();
  });

  it("stops the run whose runner is gone, and says its work is kept", async () => {
    const env = await setup();
    await env.app.submitForTest("/auto stop");
    expect(await env.notice()).toContain("The runner was not running. The run is stopped");
    expect((await env.ledger.state()).outcome).toBe("cancelled_after_checkpoint");
    expect(env.screen()).toContain("Ended: stopped; verified work kept");
    expect(
      (await env.docker.calls()).some((c) => c[0] === "rm" && c.includes(env.run.container)),
    ).toBe(true);
    await env.app.stop();
  });

  it("reports why a run cannot start, and never runs the runner in the screen", async () => {
    const env = await setup();
    await env.app.submitForTest('/auto start --image "node:22-slim"');
    expect(await env.notice()).toContain("is not a Git repository");
    await env.app.submitForTest("/auto run somewhere");
    expect(await env.notice()).toContain("The runner starts from /auto start or /auto resume.");
    await env.app.submitForTest('/auto start --image "unclosed');
    expect(await env.notice()).toContain("A quote is not closed.");
    await env.app.stop();
  });
});
