import { lifecycleBlocker, projectLifecycleActions } from "./project-status.js";
import type { ProjectSnapshot } from "./types.js";

/**
 * Validity of the infrequent project actions shown in the labeled Project
 * menu. Pure over the snapshot so the menu shows only actions that can
 * actually run; the main process still enforces its own lifecycle guards.
 */
type ProjectActionId =
  | "newConversation"
  | "newRun"
  | "compact"
  | "history"
  | "settings"
  | "archive"
  | "remove";

interface ProjectActionConfirm {
  title: string;
  body: string;
  confirmLabel: string;
}

export interface ProjectAction {
  id: ProjectActionId;
  label: string;
  description: string;
  destructive: boolean;
  /** Present when the action changes or discards state and needs confirmation. */
  confirm?: ProjectActionConfirm;
}

interface ProjectActionMenu {
  actions: ProjectAction[];
  /** Why lifecycle actions are hidden right now, if they are. */
  blockedReason?: string;
}

// One authority for lifecycle validity: the same guard the main process
// re-checks before acting.
export { lifecycleBlocker };

/** Statuses in which the Project Manager is answering, so its conversation cannot be compacted. */
const MANAGER_WORKING: readonly string[] = ["planning", "reviewing"];

const MENU_COPY: Record<
  "newConversation" | "newRun" | "archive" | "remove",
  { description: string; title: (name: string) => string; confirmLabel: string }
> = {
  newConversation: {
    description: "Fresh manager context. Current work moves to History.",
    title: () => "Start a new conversation?",
    confirmLabel: "Start new conversation",
  },
  newRun: {
    description: "Clear the plan approval and tasks. Keep the conversation.",
    title: () => "Start a new run?",
    confirmLabel: "Start new run",
  },
  archive: {
    description: "Hide from the project list. History is kept.",
    title: (name) => `Archive ${name}?`,
    confirmLabel: "Archive project",
  },
  remove: {
    description: "Delete Dispatch's records. Never deletes the source folder.",
    title: (name) => `Remove ${name} from Dispatch?`,
    confirmLabel: "Remove from Dispatch",
  },
};

/**
 * Menu view over projectLifecycleActions(): availability, labels and
 * consequences come from that single authority (also enforced by the main
 * process); this adds only presentation and the non-lifecycle entries.
 */
export function projectMenuActions(input: {
  snapshot: ProjectSnapshot;
  approvals?: { projectId?: string }[];
  busy?: boolean;
}): ProjectActionMenu {
  const { snapshot } = input;
  const { project } = snapshot;
  const lifecycle = projectLifecycleActions(input);
  const blocked = lifecycleBlocker(input);
  const actions: ProjectAction[] = [];
  const add = (id: keyof typeof MENU_COPY) => {
    const view = lifecycle.find((item) => item.id === id);
    if (!view?.available) return;
    const copy = MENU_COPY[id];
    actions.push({
      id,
      label: view.label.endsWith("…") ? view.label : `${view.label}…`,
      description: copy.description,
      destructive: view.destructive,
      confirm: {
        title: copy.title(project.name),
        body:
          id === "remove"
            ? `${view.consequence} ${sourceSentence(snapshot)} This cannot be undone.`
            : view.consequence,
        confirmLabel: copy.confirmLabel,
      },
    });
  };
  add("newConversation");
  add("newRun");
  // Not a lifecycle action: nothing is cleared or archived, so it needs no
  // confirmation. It is offered whenever there is a conversation and the
  // manager is not answering; running work does not stop it, and the
  // orchestrator refuses it for the one case that cannot share a model slot.
  if (!input.busy && snapshot.messages.length && !MANAGER_WORKING.includes(project.status))
    actions.push({
      id: "compact",
      label: "Compact conversation",
      description:
        "Summarise older messages to free up context. The brief and recent turns are kept.",
      destructive: false,
    });
  actions.push({
    id: "history",
    label: "History",
    description: "Previous conversations, plans and tasks.",
    destructive: false,
  });
  actions.push({
    id: "settings",
    label: "Project settings",
    description: "Models, permissions, checks and repository access.",
    destructive: false,
  });
  add("archive");
  add("remove");
  return {
    actions,
    blockedReason: blocked
      ? `New conversation, new run, archive and remove are hidden while work is active. ${blocked}`
      : undefined,
  };
}

function sourceSentence(snapshot: ProjectSnapshot): string {
  const source = snapshot.project.source as { kind: string; originalPath?: string };
  if (source.kind === "local_folder" && source.originalPath)
    return `The folder ${source.originalPath} is not touched.`;
  return "The source folder and any remote repository are not touched.";
}
