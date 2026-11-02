/** The whole screens: conversation, board and setup. */

import { planApprovalLabel } from "@shared/permissions";
import { projectStatusView } from "@shared/project-status";
import { destinationLabel } from "@shared/roles";
import { type AppStateView } from "@shared/types";
import { clip, labelled, padTo, wrap } from "./chrome.js";
import { type ColourRole, type Colours, PLAIN } from "./colour.js";
import { renderHeader } from "./render-banner.js";
import { renderComposerHint, renderConversationFooter } from "./render-hints.js";
import { renderTasks } from "./render-tasks.js";
import {
  bulleted,
  heading,
  KEY_HINTS,
  renderTranscript,
  Screen,
  subheading,
  withCommands,
} from "./render-text.js";

/**
 * The conversation as a pipe gets it: the whole product on the happy path. A
 * pending decision replaces the plan and the transcript tail, because it is
 * the only thing the user can usefully act on.
 */
export function renderConversation(state: AppStateView, width: number): Screen {
  const snapshot = state.snapshot;
  if (!snapshot)
    return {
      lines: ["Open a folder to begin.", "", "  dispatch <folder>"],
      hint: "No project is open.",
    };
  const status = projectStatusView(snapshot, { approvals: state.approvals });
  const lines = [...renderHeader(state, status, width), ""];

  const pending = (state.approvals ?? []).find(
    (item) => !item.projectId || item.projectId === state.selectedProjectId,
  );
  lines.push(
    ...renderTranscript(
      pending ? snapshot.messages.slice(-4) : snapshot.messages,
      width,
      pending ? undefined : state.managerDraft,
    ),
  );
  lines.push(...renderConversationFooter(state, snapshot, status, width));
  return { lines, hint: renderComposerHint(state, status) };
}

/**
 * The plan and task board, shown in place of the conversation on Tab: the
 * desktop app's Plan and Tasks panels, in the same order, with the same
 * fields under each task.
 */
export function renderBoard(state: AppStateView, width: number, colours: Colours = PLAIN): Screen {
  const snapshot = state.snapshot;
  if (!snapshot) return { lines: ["No project is open."], hint: "" };
  const plan = snapshot.pendingBoard?.plan ?? snapshot.plan;
  const lines: string[] = [];
  const aside = plan ? `Revision ${plan.revision} · ${planApprovalLabel(plan)}` : undefined;
  lines.push(...heading(colours, "Plan", aside, width));
  if (plan) {
    lines.push(...wrap(plan.summary, width), "");
    if (plan.acceptanceCriteria?.length) {
      lines.push(subheading(colours, "Acceptance criteria"));
      lines.push(...bulleted(colours, plan.acceptanceCriteria, width), "");
    }
  } else {
    lines.push(
      colours.paint(
        "muted",
        "Nothing planned yet. Discuss the work in the conversation; the plan and its tasks appear here.",
      ),
      "",
    );
  }
  // The brief the manager keeps pinned in its context, as its own section
  // between the plan and the tasks, where the desktop app's Inspector puts it.
  // It is reference text, so it reads quieter than the plan does.
  if (snapshot.brief) {
    lines.push(
      ...heading(colours, "Project brief", undefined, width),
      ...wrap(snapshot.brief, width).map((line) => colours.paint("muted", line)),
      "",
    );
  }
  lines.push(...renderTasks(state, width, colours));
  return { lines, hint: `[${KEY_HINTS.tasks}] back to the conversation` };
}

/** One row of the setup screen: what it is, and how it stands, in words. */
function setupRow(
  colours: Colours,
  label: string,
  value: string,
  tone: ColourRole | undefined,
  width: number,
): string[] {
  return labelled(colours, label, value, width, 11, tone);
}

/** What still has to be configured before work can start. */
export function renderSetup(state: AppStateView, width: number, colours: Colours = PLAIN): Screen {
  const lines = heading(colours, "Setup", undefined, width);
  const connection = state.connection;
  lines.push(subheading(colours, "Connection"));
  lines.push(
    ...setupRow(
      colours,
      "Controller",
      connection.url || "(not set)",
      connection.url ? undefined : "review",
      width,
    ),
  );
  lines.push(
    ...setupRow(
      colours,
      "Token",
      connection.tokenConfigured ? "configured" : "(not set)",
      connection.tokenConfigured ? "ok" : "review",
      width,
    ),
  );
  lines.push(
    ...setupRow(
      colours,
      "Roles ready",
      connection.rolesReady ? "yes" : "no",
      connection.rolesReady ? "ok" : "review",
      width,
    ),
  );
  if (state.probe) {
    lines.push(
      ...setupRow(
        colours,
        "Reachable",
        state.probe.ok
          ? `yes${state.probe.version ? ` — Poundlock ${state.probe.version}` : ""}`
          : `no — ${state.probe.error ?? "unknown"}`,
        state.probe.ok ? "ok" : "fault",
        width,
      ),
    );
  }

  const bindings = Object.entries(connection.roles ?? {}).filter(([, binding]) => binding);
  lines.push("", subheading(colours, "Models"));
  if (!bindings.length) lines.push(colours.paint("muted", "  No roles are bound to a model yet."));
  const roleWidth = Math.max(11, ...bindings.map(([role]) => role.length));
  const nameWidth = Math.max(
    0,
    ...bindings.map(([, binding]) => (binding?.profileName || binding?.profileId || "").length),
  );
  for (const [role, binding] of bindings) {
    if (!binding) continue;
    const name = binding.profileName || binding.profileId;
    const where = binding.approvedDataDestination
      ? destinationLabel(binding.approvedDataDestination)
      : "";
    lines.push(
      clip(
        `  ${colours.paint("faint", padTo(role, roleWidth))}  ${padTo(name, nameWidth)}${where ? `  ${colours.paint("muted", where)}` : ""}`,
        width,
      ),
    );
  }

  const roots = state.snapshot?.project.policy.roots ?? [];
  lines.push("", subheading(colours, "Extra folders"));
  if (!roots.length)
    lines.push(
      `  ${colours.paint("muted", "none —")} ${withCommands(colours, "/grant <path> [read|write]")}`,
    );
  for (const root of roots)
    lines.push(
      `  ${colours.paint("faint", padTo(root.mode, 6))}${clip(root.path, Math.max(1, width - 8))}`,
    );

  const readGrants = state.snapshot?.project.policy.readGrants ?? [];
  lines.push("", subheading(colours, "Read exceptions"));
  if (!readGrants.length)
    lines.push(
      `  ${colours.paint("muted", "none —")} ${withCommands(colours, "/grant-file <path>")}`,
    );
  for (const grant of readGrants) lines.push(`  ${clip(grant, Math.max(1, width - 2))}`);

  lines.push("", subheading(colours, "Next"));
  // Each sentence its own paragraph, so a command is never split from what it does by a wrap.
  const guidance = [
    ...(!connection.url || !connection.tokenConfigured
      ? ["Run /connect to set the controller address and token, then bind roles here."]
      : connection.rolesReady
        ? [
            "This machine is configured. Settings are shared with the desktop app.",
            "/connect changes the controller or token.",
          ]
        : [
            "Some roles are not bound to a model yet.",
            "/connect changes the controller or token.",
          ]),
    "/models lists what Poundlock is serving; /role <role> <profile> binds one.",
    "If a turn fails because the route changed in Poundlock, run /approve-models.",
  ];
  for (const paragraph of guidance)
    for (const line of wrap(paragraph, Math.max(1, width - 2)))
      lines.push(`  ${withCommands(colours, line)}`);
  return { lines, hint: "/chat to return to the conversation, /quit to exit" };
}
