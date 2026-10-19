import { realpath } from "node:fs/promises";
import { type LifecycleActionId, lifecycleBlocker } from "@shared/project-status";
import type { ProjectActionTarget, ProjectRecord } from "@shared/types";
import type { ApprovalBroker } from "./approval-broker.js";
import { removeDir } from "./atomic-write.js";
import { isWithin } from "./file-access.js";
import { nowIso } from "./ids.js";
import type { ProjectOrchestrator } from "./orchestration.js";
import { projectDir } from "./paths.js";
import type { FileStore } from "./store.js";

/**
 * Project lifecycle (new conversation, new run, archive, remove) bound to
 * stable project and run identity, guarded against active, pending, recovery
 * states, and serialized per project.
 */
export class ProjectLifecycle {
  private readonly pending = new Set<string>();

  constructor(
    private readonly deps: {
      store: FileStore;
      orchestrator: ProjectOrchestrator;
      approvals?: ApprovalBroker;
    },
  ) {}

  /** True while a lifecycle action for this project is running. */
  isPending(projectId: string): boolean {
    return this.pending.has(projectId);
  }

  /** Load the project and reject if it is gone, being removed, or a different run. */
  async resolve(target: ProjectActionTarget): Promise<ProjectRecord> {
    const project = await this.deps.store.getProject(target.projectId);
    if (!project || project.removing) throw new Error("This project is no longer in Dispatch.");
    if (target.workflowId && project.workflowId && target.workflowId !== project.workflowId)
      throw new Error(
        "This project started a new run after you chose that action. Review the current run and choose again.",
      );
    return project;
  }

  /** The authoritative guard: the shared rule plus this process's in-memory activity. */
  async blocker(projectId: string): Promise<string | undefined> {
    const store = this.deps.store;
    const project = await store.getProject(projectId);
    if (!project) return "This project is no longer in Dispatch.";
    return lifecycleBlocker({
      snapshot: {
        project,
        plan: await store.getPlan(projectId),
        tasks: await store.getTasks(projectId),
        pendingBoard: await store.getPendingBoard(projectId),
        messages: [],
      },
      approvals: this.deps.approvals?.list(),
      busy: this.deps.orchestrator.isBusy(projectId),
    });
  }

  async run(action: LifecycleActionId, target: ProjectActionTarget): Promise<string> {
    if (this.pending.has(target.projectId))
      throw new Error("Another action for this project is still in progress.");
    this.pending.add(target.projectId);
    try {
      const project = await this.resolve(target);
      if (action === "unarchive") {
        project.archived = false;
        await this.deps.store.saveProject(project);
        return "Project restored to the active list.";
      }
      if (action === "remove") return await this.remove(project);
      const blocked = await this.blocker(project.id);
      if (blocked) throw new Error(blocked);
      if (action === "archive") {
        project.archived = true;
        await this.deps.store.saveProject(project);
        return "Project archived. Its history and files are kept; restore it from the archive at any time.";
      }
      if (action === "newConversation") {
        await this.deps.orchestrator.startFresh(project.id);
        return "Current run archived. A new manager conversation is ready. Project files were not changed.";
      }
      await this.deps.orchestrator.clearCurrentRun(project.id);
      return "Current run archived. Conversation history is kept. Project files were not changed.";
    } finally {
      this.pending.delete(target.projectId);
    }
  }

  private async remove(project: ProjectRecord): Promise<string> {
    const blocked = await this.blocker(project.id);
    if (blocked) throw new Error(`Cannot remove this project yet. ${blocked}`);
    await this.assertOwnedState(project);
    const latest = (await this.deps.store.getProject(project.id))!;
    latest.removing = { startedAt: nowIso() };
    await this.deps.store.saveProject(latest);
    await this.finishRemoval(latest);
    return "Project removed from Poundlock Dispatch. The original folder or remote repository was not deleted.";
  }

  /** Never delete anything that contains the attached source. */
  private async assertOwnedState(project: ProjectRecord): Promise<void> {
    const dir = projectDir(this.deps.store.layout.root, project.id);
    if (
      !isWithin(this.deps.store.layout.projectsDir, dir) ||
      dir === this.deps.store.layout.projectsDir
    )
      throw new Error("Refusing to remove state outside Dispatch's project data.");
    if (project.source.kind === "local_folder") {
      const original = project.source.originalPath;
      const source = await realpath(original).catch(() => original);
      const owned = await realpath(dir).catch(() => dir);
      if (isWithin(owned, source))
        throw new Error(
          "The attached folder is inside this project's Dispatch data, so removing it would delete source files. Move the folder first.",
        );
    }
  }

  private async finishRemoval(project: ProjectRecord): Promise<void> {
    this.deps.approvals?.cancel(project.id);
    await removeDir(projectDir(this.deps.store.layout.root, project.id));
    const permissions = await this.deps.store.getPermissions();
    if (permissions.grants?.[project.id]) {
      const { [project.id]: _removed, ...grants } = permissions.grants;
      await this.deps.store.savePermissions({ ...permissions, grants });
    }
    await this.deps.store.deleteProjectRecord(project.id);
  }

  /** Finish removals that were interrupted (for example by a crash) after they began. */
  async completeInterruptedRemovals(): Promise<string[]> {
    const finished: string[] = [];
    for (const project of await this.deps.store.listProjects()) {
      if (!project.removing) continue;
      await this.assertOwnedState(project);
      await this.finishRemoval(project);
      finished.push(project.id);
    }
    return finished;
  }
}
