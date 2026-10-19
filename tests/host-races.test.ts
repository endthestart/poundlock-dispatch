/**
 * The host and the orchestrator both write the project record, and by design
 * they run at the same time: a poll drives work while the user is still
 * deciding. Permission is the user's, and only the host ever writes it — so a
 * decision taken during a turn must survive whatever that turn saves.
 *
 * The dangerous case is a security one. Starting a task reads a project, waits
 * on an approval the user may take minutes over, then saves the copy it
 * started with. That copy still carries a write root the user has since
 * revoked, and the next worker starts inside it with nothing said about it.
 */
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import type { AccessRoot } from "@shared/types";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";
import {
  countingManager,
  engineFor,
  planTask,
  recordingWorker,
  workflowFixture,
} from "./support/workflow-fixture";

async function grantedFixture() {
  const base = await workflowFixture({ prefix: "host-race-" });
  const sibling = await realpath(await tempDir("host-race-grant-"));
  await mkdir(join(sibling, "src"), { recursive: true });
  const root: AccessRoot = {
    path: sibling,
    mode: "write",
    addedAt: new Date().toISOString(),
    grantedBy: "approval",
  };
  const project = (await base.store.getProject(base.project.id))!;
  project.policy.roots = [root];
  await base.store.saveProject(project);
  return { ...base, sibling };
}

describe("permission the run is holding a stale copy of", () => {
  it("is taken from the record, not from the copy, whenever the run saves", async () => {
    const f = await grantedFixture();
    // The worker's model is external, so starting a task asks first.
    f.backend.listInteractiveModels = async () => [
      {
        id: "coding",
        context_tokens: 32768,
        max_output_tokens: 4096,
        dataDestination: "external",
        workload_class: "interactive-coding",
      },
    ];
    const { manager } = countingManager(f.store, { tasks: [planTask("Task one")] });
    const broker = new ApprovalBroker();
    const engine = engineFor(f, manager, recordingWorker().worker, broker);
    await engine.sendMessage(f.project.id, "build it");
    await engine.approvePlan(f.project.id);

    // The question is raised while the run is holding a project copy. Revoking
    // here is exactly a user revoking while the question is on screen.
    const started = engine.start(f.project.id).catch(() => undefined);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    const current = (await f.store.getProject(f.project.id))!;
    current.policy.roots = [];
    await f.store.saveProject(current);
    broker.decide(broker.list()[0].id, "once");
    await started;
    await engine.tick(f.project.id).catch(() => undefined);

    expect((await f.store.getProject(f.project.id))?.policy.roots ?? []).toEqual([]);
  });

  it("does not stop the host granting permission in the first place", async () => {
    // The guard takes host-owned fields from the record; it must not freeze
    // them, or no grant would ever take effect.
    const f = await grantedFixture();
    const { manager } = countingManager(f.store, { tasks: [planTask("Task one")] });
    const engine = engineFor(f, manager, recordingWorker().worker, new ApprovalBroker());
    await engine.sendMessage(f.project.id, "build it");

    const granted = (await f.store.getProject(f.project.id))!;
    expect(granted.policy.roots).toHaveLength(1);
    expect(granted.policy.roots?.[0]?.mode).toBe("write");
  });
});
