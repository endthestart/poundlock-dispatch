/**
 * The one `DispatchHost` both front ends build: the desktop app and the
 * terminal differ only in their facilities and in the name their folder lock
 * records, so the runtime wiring behind the host is stated once.
 */
import { join } from "node:path";
import type { ApprovalBroker } from "@core/approval-broker";
import { FolderLock } from "@core/folder-lock";
import { DispatchHost, type HostFacilities } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { defaultConfigRoot } from "@core/paths";
import { ProjectLifecycle } from "@core/project-lifecycle";
import type { FileStore } from "@core/store";
import { createApprovalReviewer } from "@runtime/approval-reviewer";
import { hostCommandPort } from "@runtime/host-command";
import { createManagerProvider } from "@runtime/manager-provider";
import { createPiWorker } from "@runtime/pi-worker";

export function createDispatchHost(
  facilities: HostFacilities,
  store: FileStore,
  approvals: ApprovalBroker,
  client: { hostApp: "gui" | "tui"; dataRoot: string },
): DispatchHost {
  return new DispatchHost(facilities, store, approvals, {
    worker: () => createPiWorker(),
    // One writer per folder across clients: the desktop app and a terminal
    // session must not dispatch workers into the same tree at once.
    folderLock: new FolderLock(join(defaultConfigRoot(), "locks"), client),
    reviewAction: (created) => createApprovalReviewer(created),
    managerProvider: (wiring) =>
      createManagerProvider(
        wiring.getStore,
        wiring.approvals,
        async (text, projectId) => {
          wiring.recordActivity(text, projectId);
        },
        wiring.onSelection,
        wiring.capabilities,
      ),
    orchestrator: (deps) => new ProjectOrchestrator({ ...deps, hostCommands: hostCommandPort }),
    lifecycle: (deps) => new ProjectLifecycle(deps),
  });
}
