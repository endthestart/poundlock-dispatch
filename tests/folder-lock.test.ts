/**
 * One writer per folder, across processes. Without this a terminal session and
 * the desktop app can both dispatch workers into the same tree, and separate
 * data directories do not help — the folder is what they share.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { FolderLock, lockBlockedMessage, STALE_AFTER_MS } from "@core/folder-lock";
import { DispatchHost } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { createFolderProject } from "@core/projects";
import { hostCommandPort } from "@runtime/host-command";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";
import {
  countingManager,
  engineFor,
  planTask,
  recordingWorker,
  type WorkflowFixture,
  workflowFixture,
} from "./support/workflow-fixture";

let locks: string;
let folder: string;
let other: string;

beforeEach(async () => {
  locks = await tempDir("dispatch-locks-");
  folder = await tempDir("dispatch-folder-");
  other = await tempDir("dispatch-folder-b-");
});

function lock(hostApp: string, now?: () => Date) {
  return new FolderLock(locks, { hostApp, dataRoot: `/data/${hostApp}` }, now);
}

/** The lock file the implementation would use for this folder. */
async function lockFile(target: string): Promise<string> {
  const canonical = await realpath(target);
  return join(locks, `${createHash("sha256").update(canonical).digest("hex")}.json`);
}

/** A holder that is both long silent and definitely gone. */
function abandoned() {
  const when = new Date(Date.now() - 10 * STALE_AFTER_MS).toISOString();
  return {
    pid: 2 ** 22, // far above any pid this machine will allocate
    hostApp: "tui",
    dataRoot: "/data/tui",
    startedAt: when,
    heartbeatAt: when,
  };
}

describe("folder lock", () => {
  it("lets one client drive a folder and tells the next one who has it", async () => {
    expect(await lock("gui").acquire(folder)).toEqual({ ok: true });

    const refused = await lock("tui").acquire(folder);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.holder?.hostApp).toBe("gui");
    expect(refused.holder?.pid).toBe(process.pid);
    expect(lockBlockedMessage(refused.holder)).toMatch(/open in the desktop app/i);
    // Phrased as a mode. Telling the user to close the other client named the
    // least likely thing they wanted, for a state that is not a failure.
    expect(lockBlockedMessage(refused.holder)).not.toMatch(/close it/i);
  });

  it("does not fence a different folder", async () => {
    await lock("gui").acquire(folder);
    expect(await lock("tui").acquire(other)).toEqual({ ok: true });
  });

  it("treats the same folder reached by another path as the same folder", async () => {
    await lock("gui").acquire(folder);
    expect((await lock("tui").acquire(join(folder, "."))).ok).toBe(false);
  });

  it("reclaims a folder whose holder stopped heartbeating and no longer exists", async () => {
    await writeFile(await lockFile(folder), JSON.stringify(abandoned()), { mode: 0o600 });
    expect(await lock("gui").acquire(folder)).toEqual({ ok: true });
  });

  it("does not steal a lock from a live holder that has merely gone quiet", async () => {
    // A process paused in a debugger stops heartbeating but is still working.
    const frozen = lock("gui", () => new Date(Date.now() - 10 * STALE_AFTER_MS));
    await frozen.acquire(folder);
    expect((await lock("tui").acquire(folder)).ok).toBe(false);
  });

  it("releases on shutdown so the next client can start", async () => {
    const gui = lock("gui");
    await gui.acquire(folder);
    await gui.releaseAll();
    expect(await lock("tui").acquire(folder)).toEqual({ ok: true });
  });

  it("renews its claim in place rather than taking a new one", async () => {
    const gui = lock("gui");
    await gui.acquire(folder, { projectId: "proj-1" });
    // A lock this process holds is never reported as somebody else's.
    expect(await gui.heldBy(folder)).toBeUndefined();

    await gui.heartbeat();
    const written = JSON.parse(await readFile(await lockFile(folder), "utf8"));
    expect(written.projectId).toBe("proj-1");
    expect(written.pid).toBe(process.pid);
    expect(new Date(written.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
      new Date(written.startedAt).getTime(),
    );
  });

  it("takes several folders as one unit, or none of them", async () => {
    await lock("tui").acquire(other);

    const result = await lock("gui").acquireAll([folder, other]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.folder).toBe(other);

    // Nothing partial was left behind, so another client can take the free one.
    expect(await lock("third").acquire(folder)).toEqual({ ok: true });
  });

  it("acquires a set it can fully claim", async () => {
    expect(await lock("tui").acquireAll([folder, other], { projectId: "p" })).toEqual({ ok: true });
  });

  it("reports a foreign holder only while that holder is current", async () => {
    await writeFile(await lockFile(folder), JSON.stringify(abandoned()), { mode: 0o600 });
    expect(await lock("gui").heldBy(folder)).toBeUndefined();
  });
});

describe("the lock actually gates dispatch", () => {
  it("does not start work in a folder another client is driving", async () => {
    const fixture = await workflowFixture({ prefix: "dispatch-lock-gate-" });
    const { manager } = countingManager(fixture.store, { tasks: [planTask("Task one")] });
    const { worker, runs } = recordingWorker();

    // Somebody else already holds this folder.
    const holder = new FolderLock(locks, { hostApp: "gui", dataRoot: "/data/gui" });
    expect(await holder.acquire(fixture.folder)).toEqual({ ok: true });

    const mine = new FolderLock(locks, { hostApp: "tui", dataRoot: "/data/tui" });
    expect((await mine.acquire(fixture.folder)).ok).toBe(false);

    const engine = engineFor(fixture, manager, worker, new ApprovalBroker(), mine);
    await engine.sendMessage(fixture.project.id, "build it");
    await engine.approvePlan(fixture.project.id);
    await engine.start(fixture.project.id).catch(() => undefined);
    await engine.tick(fixture.project.id).catch(() => undefined);
    expect(runs).toEqual([]);

    // Once the other client lets go, the same run proceeds.
    await holder.releaseAll();
    expect(await mine.acquire(fixture.folder)).toEqual({ ok: true });
    await engine.tick(fixture.project.id);
    expect(runs.length).toBeGreaterThan(0);
  });

  /**
   * The gate is the dangerous direction: a lock this process really holds that
   * reports otherwise stops every dispatch, silently, forever. Both cases below
   * shipped on 2026-09-20.
   */
  it("holds a folder whatever path it was named by", async () => {
    // `acquire` canonicalises; `holds` must answer about the same folder, not
    // the same string. macOS hands out /tmp paths that are really /private/tmp.
    const link = join(other, "link");
    await symlink(folder, link);

    const gui = lock("gui");
    expect(await gui.acquire(link)).toEqual({ ok: true });
    expect(gui.holds(link)).toBe(true);
    expect(gui.holds(folder)).toBe(true);
    expect(gui.holds(await realpath(link))).toBe(true);
  });

  it("says so rather than ticking in silence when it is not the writer", async () => {
    // A poll that refuses to dispatch and says nothing is indistinguishable
    // from a hung project: the status still reads "working" every 2.5 s.
    const fixture = await workflowFixture({ prefix: "dispatch-lock-quiet-" });
    const { manager } = countingManager(fixture.store, { tasks: [planTask("Task one")] });
    const { worker, runs } = recordingWorker();

    const holder = new FolderLock(locks, { hostApp: "gui", dataRoot: "/data/gui" });
    await holder.acquire(fixture.folder);
    const mine = new FolderLock(locks, { hostApp: "tui", dataRoot: "/data/tui" });

    const engine = engineFor(fixture, manager, worker, new ApprovalBroker(), mine);
    await engine.sendMessage(fixture.project.id, "build it");
    await engine.approvePlan(fixture.project.id);
    await engine.start(fixture.project.id).catch(() => undefined);
    await engine.tick(fixture.project.id).catch(() => undefined);
    await engine.tick(fixture.project.id).catch(() => undefined);
    expect(runs).toEqual([]);

    const said = (await fixture.store.getMessages(fixture.project.id)).filter((message) =>
      /nothing will start from here/i.test(message.text),
    );
    expect(said).toHaveLength(1); // said once, not once per poll
    expect(said[0].text).toMatch(/open in the desktop app/i);
    // It must still name the folder, so a user with several projects open can
    // tell which one is parked.
    expect(said[0].text).toContain(fixture.folder);
  });
});

/**
 * Watching is a per-project mode, and it used to be reported as an app-wide
 * notice that was only ever written and never cleared. Opening one folder a
 * terminal session held therefore put an error banner on screen that stayed
 * there for every other project afterwards — none of which were locked.
 */
describe("what the other client's lock looks like to the user", () => {
  async function hostWith(lockPort: FolderLock, fixture: WorkflowFixture) {
    const { manager } = countingManager(fixture.store, { tasks: [planTask("Task one")] });
    const { worker } = recordingWorker();
    const approvals = new ApprovalBroker(() => undefined);
    return new DispatchHost({ dataRoot: fixture.store.layout.root }, fixture.store, approvals, {
      worker: () => worker,
      folderLock: lockPort,
      managerProvider: () => ({
        get: async () => manager,
        reset: async () => undefined,
        abort: () => undefined,
        clear: () => undefined,
      }),
      orchestrator: (deps) =>
        new ProjectOrchestrator({
          hostCommands: hostCommandPort,
          ...deps,
          clientFor: async () => fixture.backend,
        }),
      lifecycle: (deps) => new ProjectLifecycle(deps),
    });
  }

  it("marks only the project another client actually holds", async () => {
    const fixture = await workflowFixture({ prefix: "dispatch-lock-view-" });
    const second = join(fixture.root, "second");
    await mkdir(second);
    const untouched = await createFolderProject({ store: fixture.store, folder: second });

    // Another client takes the first project's folder, and only that one.
    const theirs = new FolderLock(locks, { hostApp: "tui", dataRoot: "/data/tui" });
    expect((await theirs.acquire(fixture.folder)).ok).toBe(true);

    const host = await hostWith(
      new FolderLock(locks, { hostApp: "gui", dataRoot: fixture.store.layout.root }),
      fixture,
    );

    await host.selectProject(fixture.project.id);
    const locked = await host.getState();
    expect(locked.watching?.heldBy).toBe("tui");
    // And it is not an error — reading is a supported mode.
    expect(locked.notice?.kind).not.toBe("error");

    // The bug: this project is not held by anyone, and used to inherit the
    // banner from the one that was.
    await host.selectProject(untouched.id);
    const free = await host.getState();
    expect(free.watching).toBeUndefined();
    expect(free.notice?.kind).not.toBe("error");
  });

  it("stops watching once the other client lets go", async () => {
    const fixture = await workflowFixture({ prefix: "dispatch-lock-view-b-" });
    const theirs = new FolderLock(locks, { hostApp: "tui", dataRoot: "/data/tui" });
    await theirs.acquire(fixture.folder);

    const host = await hostWith(
      new FolderLock(locks, { hostApp: "gui", dataRoot: fixture.store.layout.root }),
      fixture,
    );
    await host.selectProject(fixture.project.id);
    expect((await host.getState()).watching).toBeDefined();

    await theirs.releaseAll();
    await host.selectProject(fixture.project.id);
    expect((await host.getState()).watching).toBeUndefined();
  });
});
