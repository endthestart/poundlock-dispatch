import { newId } from "./ids.js";

/** Pi conversations store messages only. Dispatch workflows authorize plans, tasks, and attempts. */
interface WorkflowIdentity {
  workflowId: string;
  managerConversationId: string;
}

interface WorkflowCheckpoint {
  workflowId: string;
  revision: number;
  planRevision: number;
  managerConversationId: string;
  workerConversations: Record<string, string>;
  /** Restored Pi sessions may continue chat, but cannot dispatch or accept work. */
  dispatchAuthorized: boolean;
}

export function newWorkflowIdentity(): WorkflowIdentity {
  return {
    workflowId: newId("wf"),
    managerConversationId: newId("mgr"),
  };
}

export function initialWorkflowCheckpoint(identity: WorkflowIdentity): WorkflowCheckpoint {
  return {
    workflowId: identity.workflowId,
    revision: 1,
    planRevision: 0,
    managerConversationId: identity.managerConversationId,
    workerConversations: {},
    dispatchAuthorized: false,
  };
}

export function assertWorkflowCanDispatch(checkpoint: WorkflowCheckpoint | undefined): void {
  if (!checkpoint?.dispatchAuthorized) {
    throw new Error(
      "This Pi conversation was restored without an active Dispatch workflow. It cannot start or repeat work until you approve a plan or resume.",
    );
  }
}
