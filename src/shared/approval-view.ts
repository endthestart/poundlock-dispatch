import { approvalHeadline, approvalPrimary, rememberLabel } from "./approval-copy.js";
import { visibleControls } from "./display-safe.js";
import type { ToolApproval } from "./permissions.js";

/**
 * Ordinary-language view of a pending action approval: what will happen, why,
 * within what scope, where data goes and what follows. Exact commands stay
 * available on expansion instead of leading the card.
 */
interface ApprovalView {
  headline: string;
  action: string;
  reason: string;
  scope: string;
  destination: string;
  consequences: string;
  /** Exact command, path or request, shown on expansion. */
  exact: string;
  /** Worker-requested form when Dispatch rewrote it. */
  requested?: string;
  once: string;
  remember: string;
  rememberDetail: string;
  deny: string;
}

function folderName(path?: string): string | undefined {
  if (!path) return undefined;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed;
}

/** The request with everything it carries from a model or a project written out visibly. */
function visibleRequest(request: ToolApproval): ToolApproval {
  const shown = (text: string | undefined) => (text === undefined ? text : visibleControls(text));
  return {
    ...request,
    action: visibleControls(request.action),
    reason: visibleControls(request.reason ?? ""),
    cwd: shown(request.cwd),
    displayCommand: shown(request.displayCommand),
    requestedCommand: shown(request.requestedCommand),
  };
}

export function approvalView(approval: ToolApproval): ApprovalView {
  const request = visibleRequest(approval);
  const exact = approvalPrimary(request);
  const folder = folderName(request.cwd);
  const planScope = `Plan revision ${request.planRevision}${request.taskId ? ", one task" : ""}`;
  const base = {
    headline: approvalHeadline(request.kind),
    reason: request.reason?.trim() || "The worker did not give a reason.",
    exact,
    requested:
      request.requestedCommand && request.requestedCommand !== exact
        ? request.requestedCommand
        : undefined,
    once: "Allow once",
    remember: rememberLabel(request),
    deny: "Deny",
  };
  switch (request.kind) {
    case "bash":
      return {
        ...base,
        action: `Run a command${folder ? ` in ${folder}` : ""}.`,
        scope: `${request.cwd ? `Working directory ${request.cwd}` : "The project folder"} · ${planScope}`,
        destination: "Runs on this Mac.",
        consequences:
          "The command can change files in its working directory. Allow once permits only this exact command, now.",
        rememberDetail:
          "Saves a permission for this exact command in this folder. Other commands still ask.",
      };
    case "write":
      return {
        ...base,
        action: "Edit a file.",
        scope: `${request.cwd ? `In ${request.cwd}` : "In the project"} · ${planScope}`,
        destination: "Stays on this Mac.",
        consequences: "The file's contents are replaced or created. Review evidence records it.",
        rememberDetail: "Saves a permission for edits to this exact file.",
      };
    case "read":
      return {
        ...base,
        action: "Read a file that is excluded by default.",
        scope: planScope,
        destination: "The contents go to the model working on this task.",
        consequences: "Excluded files can contain secrets. Deny if you are unsure.",
        rememberDetail: "Saves a read exception for this exact file.",
      };
    case "inference":
      return {
        ...base,
        action: "Use a model that needs your approval.",
        scope: planScope,
        destination: "Selected project context is sent to that model's provider.",
        consequences: "No files change. The provider may retain what it receives.",
        rememberDetail: "Allows this model route for the rest of this plan.",
      };
    case "offbox":
      return {
        ...base,
        action: "Send work off this Mac.",
        scope: planScope,
        destination: "Project context leaves this Mac.",
        consequences: "Deny to keep the work local.",
        rememberDetail: "Allows this destination for the rest of this plan.",
      };
    default:
      return {
        ...base,
        action: "Perform an action that needs approval.",
        scope: planScope,
        destination: request.cwd ? `In ${request.cwd}` : "On this Mac.",
        consequences: "Review the exact request before allowing it.",
        rememberDetail: "Saves a permission for this exact action.",
      };
  }
}
