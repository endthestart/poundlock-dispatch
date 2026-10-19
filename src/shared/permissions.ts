export type ToolTrustMode = "ask" | "assist" | "full";

export const TOOL_TRUST_MODES: Array<{
  id: ToolTrustMode;
  label: string;
  hint: string;
}> = [
  {
    id: "ask",
    label: "Ask for approval",
    hint: "Ask before a local sub-agent runs a shell command or does destructive work. Ordinary file edits inside the attached project do not wait for a card.",
  },
  {
    id: "assist",
    label: "Approve for me",
    hint: "Allow project setup, edits and test/build commands inside the operating-system sandbox. Raw Bash is disabled. Anything the sandbox cannot enforce asks you.",
  },
  {
    id: "full",
    label: "Full access",
    hint: "Allow local commands with the authority of this user account. That can read or modify any file this account can access. External inference still requires its own approval, and the project's network switches still apply.",
  },
];

export interface SavedPermission {
  kind: "bash" | "write";
  action: string;
  cwd: string;
}
export interface PermissionSettings {
  defaultMode: ToolTrustMode;
  /** App-wide fix rounds per task (Settings); a project may override it. Absent means 2. */
  fixRoundsPerTask?: number;
  reviewer?: { profileId?: string; qualifiedProfileIds?: string[] };
  grants?: Record<string, SavedPermission[]>;
}

type LocalToolKind = "read" | "write" | "bash" | "offbox";

export function defaultPermissions(): PermissionSettings {
  return { defaultMode: "ask" };
}

function parseToolTrustMode(value: unknown): ToolTrustMode | undefined {
  if (value === "ask" || value === "assist" || value === "full") return value;
  return undefined;
}

export function normalizePermissions(raw: unknown): PermissionSettings {
  if (!raw || typeof raw !== "object") return defaultPermissions();
  const mode = parseToolTrustMode((raw as { defaultMode?: unknown }).defaultMode);
  const value = raw as PermissionSettings;
  const grants: Record<string, SavedPermission[]> = {};
  for (const [id, rules] of Object.entries(value.grants ?? {})) {
    if (!Array.isArray(rules)) continue;
    grants[id] = rules.filter(
      (r) =>
        r &&
        ["bash", "write"].includes(r.kind) &&
        typeof r.action === "string" &&
        r.action.length <= 12000 &&
        typeof r.cwd === "string" &&
        r.cwd.startsWith("/"),
    );
  }
  const rounds = (raw as { fixRoundsPerTask?: unknown }).fixRoundsPerTask;
  return {
    defaultMode: mode ?? "ask",
    ...(typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 0 && rounds <= 5
      ? { fixRoundsPerTask: rounds }
      : {}),
    ...(value.grants ? { grants } : {}),
    ...(value.reviewer
      ? {
          reviewer: {
            profileId:
              typeof value.reviewer?.profileId === "string" ? value.reviewer.profileId : undefined,
            qualifiedProfileIds: (Array.isArray(value.reviewer?.qualifiedProfileIds)
              ? value.reviewer.qualifiedProfileIds
              : []
            ).filter((id) => typeof id === "string"),
          },
        }
      : {}),
  };
}

export function effectiveToolTrust(
  projectTrust: ToolTrustMode | undefined,
  app: PermissionSettings,
): ToolTrustMode {
  return projectTrust ?? app.defaultMode;
}

export function toolTrustLabel(mode: ToolTrustMode): string {
  return TOOL_TRUST_MODES.find((item) => item.id === mode)?.label ?? mode;
}

/**
 * What the conversation says when Dispatch approved a plan itself, because no
 * Approve click happened to show it. Both clients render this same message.
 */
export function autoApprovalNotice(input: { mode: ToolTrustMode; taskTitle: string }): string {
  return `${toolTrustLabel(input.mode)}: \u201c${input.taskTitle}\u201d started without an Approve click, because it is within the listed permissions and run limits. You can pause or cancel it.`;
}

/** The plan header's approval state. */
export function planApprovalLabel(plan: {
  approved: boolean;
  autoApprovedUnder?: ToolTrustMode;
}): string {
  if (!plan.approved) return "Not yet approved";
  return plan.autoApprovedUnder
    ? `Approved automatically (${toolTrustLabel(plan.autoApprovedUnder)})`
    : "Approved";
}

/**
 * Whether Poundlock Dispatch may run this action without a decision card.
 * Off-box work and external inference never auto-allow, including Full access.
 * Ordinary in-project writes auto-allow in every mode; ignored, secret, symlink,
 * and outside paths are still gated by the worker path policy. Commands never
 * auto-allow in Ask. Assist needs command context; the worker applies its rules.
 */
export function localToolsAutoAllow(mode: ToolTrustMode, kind: LocalToolKind): boolean {
  if (kind === "offbox") return false;
  if (kind === "read" || kind === "write") return true;
  if (mode === "ask") return false;
  if (mode === "full") return true;
  return false;
}

export interface ToolApproval {
  id: string;
  projectId: string;
  projectName: string;
  taskId?: string;
  planRevision: number;
  kind: string;
  action: string;
  reason: string;
  cwd?: string;
  /** Command or path shown to the user (after any Dispatch rewrite). */
  displayCommand?: string;
  /** Worker-requested invocation when it differs from displayCommand. */
  requestedCommand?: string;
}
export type ToolApprovalDecision = "once" | "always" | "deny";
