import { composerSendBlocked, submitComposerDraft } from "@shared/composer-guard";
import { conversationTimeline } from "@shared/live-work-view";
import { projectNeedsYou } from "@shared/needs-you";
import { effectiveToolTrust } from "@shared/permissions";
import { IN_FLIGHT, projectStatusView } from "@shared/project-status";
import { reasoningLabel } from "@shared/reasoning";
import {
  catalogFromProbe,
  catalogMatchesBinding,
  managerChoice,
  profileDisplayName,
} from "@shared/roles";
import { projectStatusTone } from "@shared/status-tone";
import {
  type AppStateView,
  type ForgeKind,
  type IntegrationsPublic,
  type RunHistoryRecord,
  statusLabel,
  TASK_EXECUTION_PLACE,
} from "@shared/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApprovalPanel } from "./approvals";
import { AutopilotPanel } from "./autopilot";
import { useConversationFollow } from "./conversation-follow";
import { Dialog } from "./dialog";
import { usePanelLayout } from "./layout";
import { Markdown } from "./Markdown";
import { ProjectMenu } from "./project-menu";
import {
  ComposerInfolets,
  DecisionDock,
  Inspector,
  LiveWorkEvent,
  LiveWorkLog,
  MessageToolTrace,
  PlanProposal,
  ReasoningChip,
  TrustChip,
} from "./project-panes";
import { SettingsModal } from "./project-settings";
import { type SettingsNav, SettingsPage, SetupWizard } from "./settings";

function currentTaskPlace(selected: NonNullable<AppStateView["snapshot"]>): string | undefined {
  return selected.tasks.some((item) => IN_FLIGHT.includes(item.status))
    ? TASK_EXECUTION_PLACE
    : undefined;
}

function speaker(role: string): string {
  return role === "user" ? "You" : role === "manager" ? "Project Manager" : "Poundlock Dispatch";
}

export function App() {
  const [state, setState] = useState<AppStateView>();
  const [draft, setDraft] = useState("");
  const [settingsNav, setSettingsNav] = useState<SettingsNav>("connection");
  const [showSettings, setShowSettings] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [history, setHistory] = useState<RunHistoryRecord[]>();
  const [expandedTasks, setExpandedTasks] = useState<ReadonlySet<string>>(() => new Set());
  const [info, setInfo] = useState<string>();
  const follow = useConversationFollow();
  const conversationProject = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const layout = usePanelLayout();

  useEffect(() => {
    if (!window.poundlockDispatch) {
      setError(
        "Poundlock Dispatch could not start its desktop bridge. Quit and reopen the app. If this is a packaged build, the preload script failed to load.",
      );
      return;
    }
    void window.poundlockDispatch
      .state()
      .then((next: AppStateView) => setState(next))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return window.poundlockDispatch.onState(setState);
  }, []);

  // Live-switch: main.tsx sets the initial flavour before first paint from
  // the value the main process resolved; this keeps it in step afterwards,
  // for example right after Settings → Appearance saves a new choice.
  useEffect(() => {
    const theme = state?.appearance.theme;
    if (!theme || theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [state?.appearance.theme]);

  const selected = state?.snapshot;
  const statusView = selected
    ? projectStatusView(selected, { approvals: state?.approvals })
    : undefined;
  // While Autopilot works the project, its panel is the project's status.
  const autopilotLive = ["preparing", "running"].includes(state?.autopilot?.phase ?? "");

  // Opening another project starts at its latest message. Anything that
  // arrives afterwards is followed by the hook, however it arrives.
  const projectId = selected?.project.id;
  const jumpToLatest = follow.jumpToLatest;
  useLayoutEffect(() => {
    if (!projectId || conversationProject.current === projectId) return;
    conversationProject.current = projectId;
    jumpToLatest();
  }, [projectId, jumpToLatest]);

  useEffect(() => {
    if (!layout.overlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"], [role="menu"]'))
        layout.closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout.overlay]);

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      setError(undefined);
      setInfo(undefined);
      const result = await work();
      if (result && typeof result === "object" && "projects" in (result as object)) {
        setState(result as unknown as AppStateView);
      }
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    }
  }

  if (!state) {
    return (
      <div className="empty" role={error ? "alert" : "status"}>
        {error ? error : "Opening Poundlock Dispatch…"}
      </div>
    );
  }

  if (!state.connection.rolesReady) {
    return <SetupWizard state={state} onState={setState} />;
  }

  const choice = selected ? managerChoice(selected.project, state.connection.roles) : undefined;
  const managerProfile =
    choice && state.probe
      ? catalogMatchesBinding(catalogFromProbe(state.probe), {
          profileId: choice.id,
          profileName: choice.fallbackName,
          source: "interactive",
        })
      : undefined;
  const activeManager =
    state.managerSelection?.projectId === selected?.project.id ? state.managerSelection : undefined;
  const managerName =
    activeManager?.name ??
    (managerProfile ? profileDisplayName(managerProfile) : choice?.fallbackName);
  const managerOrigin = activeManager?.origin ?? choice?.origin;

  if (showSettings) {
    return (
      <SettingsPage
        state={state}
        nav={settingsNav}
        onNav={setSettingsNav}
        onState={setState}
        onBack={() => setShowSettings(false)}
        approvals={<ApprovalPanel state={state} onState={setState} />}
      />
    );
  }

  const activeProjects = state.projects.filter((project) => !project.archived);
  const archivedProjects = state.projects.filter((project) => project.archived);
  const { fit } = layout;
  const leftVisible = layout.visible("left");
  const rightVisible = layout.visible("right");
  const sendBlocked = selected
    ? composerSendBlocked({
        approvals: state.approvals,
        needsInput: selected.project.needsInput,
        projectId: selected.project.id,
      })
    : undefined;
  const sendDisabledReason =
    sendBlocked ??
    (state.busy && !(state.managerTurning && !selected?.project.needsInput)
      ? "The Project Manager is working. Keep typing; Send is available when it finishes."
      : undefined);

  function compactConversation() {
    if (!selected) return;
    const target = { projectId: selected.project.id, workflowId: selected.project.workflowId };
    void run(() => window.poundlockDispatch.compactConversation(undefined, target));
  }

  const sidebar = (
    <aside
      className={`sidebar ${layout.overlay === "left" ? "overlay" : ""}`}
      aria-label="Projects"
      style={{ width: fit.left }}
    >
      <div className="brand">Poundlock Dispatch</div>
      <div className="section-head">
        <h2 id="projects-heading">Projects</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Add project"
          title="Add project"
          onClick={() => setShowNew(true)}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>
      <nav className="project-list" aria-labelledby="projects-heading">
        {activeProjects.length === 0 ? (
          <p className="hint">No projects yet. Add a folder on this Mac or a Git repository.</p>
        ) : (
          <ul>
            {activeProjects.map((project) => {
              const open = project.id === state.selectedProjectId;
              const needsYou = projectNeedsYou(project, state.approvals);
              return (
                <li key={project.id}>
                  <button
                    className={`project-item ${open ? "active" : ""}`}
                    type="button"
                    aria-current={open ? "page" : undefined}
                    onClick={() => {
                      layout.closeOverlay();
                      void run(async () => window.poundlockDispatch.openProject(project.id));
                    }}
                  >
                    <span
                      className={`row-indicator${needsYou ? " tick tone-review" : ""}`}
                      aria-hidden="true"
                    />
                    {needsYou ? <span className="sr-only">Needs you. </span> : null}
                    <span className="name">{project.name}</span>
                    <span className="meta">
                      {state.autopilotProjects?.[project.id] === "building"
                        ? "Autopilot"
                        : state.autopilotProjects?.[project.id] === "interrupted"
                          ? "Autopilot stopped"
                          : statusLabel(project.status)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {archivedProjects.length ? (
          <details className="archived">
            <summary>Archived projects ({archivedProjects.length})</summary>
            <ul>
              {archivedProjects.map((project) => (
                <li key={project.id} className="archived-item">
                  <span>{project.name}</span>
                  <button
                    type="button"
                    className="quiet small"
                    aria-label={`Restore ${project.name}`}
                    title="Returns the project to the active list. History and files are unchanged."
                    onClick={() =>
                      void run(async () =>
                        window.poundlockDispatch.projectLifecycle("unarchive", {
                          projectId: project.id,
                        }),
                      )
                    }
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </nav>
      <button type="button" className="sidebar-settings" onClick={() => setShowSettings(true)}>
        Settings
      </button>
    </aside>
  );

  return (
    <div className="app">
      {leftVisible ? sidebar : null}
      {fit.leftDocked ? <div {...layout.separatorProps("left", "Resize projects panel")} /> : null}
      <main className="main">
        <header className="chat-head">
          <button
            type="button"
            className="icon-btn panel-toggle"
            aria-label={leftVisible ? "Hide projects panel" : "Show projects panel"}
            aria-expanded={leftVisible}
            title={leftVisible ? "Hide projects panel" : "Show projects panel"}
            onClick={() => layout.toggle("left")}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M6 3v10" />
            </svg>
          </button>
          {selected ? (
            <div className="chat-title">
              <h1>{selected.project.name}</h1>
              {autopilotLive ? (
                <span className="state-pill tone-active">Autopilot</span>
              ) : (
                <span
                  className={`state-pill ${projectStatusTone(selected.project.status, statusView?.active ?? false)}`}
                >
                  {statusLabel(selected.project.status)}
                </span>
              )}
            </div>
          ) : (
            <div className="chat-title">
              <h1>Poundlock Dispatch</h1>
            </div>
          )}
          <span className="spacer" />
          {selected ? (
            <ProjectMenu
              state={state}
              selected={selected}
              onHistory={() =>
                void run(async () => {
                  setHistory(await window.poundlockDispatch.runHistory());
                })
              }
              onSettings={() => setShowProjectSettings(true)}
              onCompact={compactConversation}
              onState={setState}
              onDraftReset={() => setDraft("")}
            />
          ) : null}
          <button
            type="button"
            className="icon-btn panel-toggle"
            aria-label={rightVisible ? "Hide plan and tasks panel" : "Show plan and tasks panel"}
            aria-expanded={rightVisible}
            title={rightVisible ? "Hide plan and tasks panel" : "Show plan and tasks panel"}
            onClick={() => layout.toggle("right")}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <path d="M10 3v10" />
            </svg>
          </button>
        </header>
        {selected && managerName ? (
          <p className="manager-model-line">
            Manager: <strong>{managerName}</strong> ·{" "}
            {managerOrigin === "default"
              ? "App default"
              : managerOrigin === "project"
                ? "Project override"
                : managerOrigin === "local"
                  ? "This computer"
                  : "Model ladder"}
          </p>
        ) : null}
        {state.watching ? (
          // A mode, not an alert: role="status", no error styling, no Dismiss —
          // there is nothing to dismiss, and it goes away by itself when the
          // other client releases the folder.
          <div className="notice watching" role="status">
            <span>
              Watching this project.{" "}
              {state.watching.heldBy === "tui"
                ? "The terminal client is driving the work."
                : state.watching.heldBy === "gui"
                  ? "The desktop app is driving the work."
                  : "Another Poundlock Dispatch client is driving the work."}{" "}
              Everything here is live; only starting new work is held.
            </span>
          </div>
        ) : null}
        {error || info || state.notice ? (
          <div
            className={`notice ${error || (!info && state.notice?.kind === "error") ? "error" : ""}`}
            role={error ? "alert" : "status"}
          >
            <span>{error || info || state.notice?.text}</span>
            {error || info ? (
              <button
                type="button"
                className="quiet small"
                onClick={() => {
                  setError(undefined);
                  setInfo(undefined);
                }}
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}
        {!selected ? (
          <div className="empty">
            <h2>Start with a project</h2>
            <p>
              Add a folder on this Mac or a Git repository. Work happens there; manager notes stay
              in Poundlock Dispatch, not the repository.
            </p>
            <button type="button" className="primary" onClick={() => setShowNew(true)}>
              Add project
            </button>
          </div>
        ) : (
          <>
            <div className="conversation-shell">
              <div
                className="conversation"
                ref={follow.ref}
                role="log"
                aria-label="Conversation with the Project Manager"
                tabIndex={0}
                onScroll={follow.onScroll}
              >
                {!selected.messages.length ? (
                  <p className="hint conversation-empty">
                    Ask the Project Manager a question, agree a small change, or describe work to
                    plan.
                  </p>
                ) : null}
                {conversationTimeline(selected.messages, state.liveWork, state.activity).map(
                  (item, index) =>
                    item.kind === "activity" ? (
                      <LiveWorkEvent
                        key={`activity:${index}:${item.entry.at}`}
                        entry={item.entry}
                      />
                    ) : (
                      <article
                        key={item.message.id}
                        className={`msg ${item.message.role}${item.message.kind === "notice" ? " msg-notice" : ""}`}
                      >
                        <header className="msg-head">
                          <span className="who">{speaker(item.message.role)}</span>
                          {item.message.reasoning &&
                          !["model_default", "none"].includes(item.message.reasoning) ? (
                            <span className="message-reasoning">
                              Reasoning: {reasoningLabel(item.message.reasoning).toLowerCase()}
                            </span>
                          ) : null}
                          <time className="message-time" dateTime={item.message.createdAt}>
                            {new Date(item.message.createdAt).toLocaleString([], {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </time>
                        </header>
                        <div className="body">
                          {item.message.role === "user" ? (
                            item.message.text
                          ) : (
                            <Markdown text={item.message.text} />
                          )}
                        </div>
                        <MessageToolTrace trace={item.message.toolTrace} />
                      </article>
                    ),
                )}
                {state.managerDraft?.trim() ? (
                  // Styled as the manager message it is about to become, minus
                  // the timestamp — the turn has not produced one yet.
                  <article className="msg manager draft">
                    <header className="msg-head">
                      <span className="who">{speaker("manager")}</span>
                    </header>
                    <div className="body">
                      <Markdown text={state.managerDraft} />
                    </div>
                  </article>
                ) : null}
                <PlanProposal state={state} selected={selected} />
                <LiveWorkLog activity={state.activity} place={currentTaskPlace(selected)} />
              </div>
              {follow.unseen ? (
                <button type="button" className="jump-to-latest" onClick={follow.jumpToLatest}>
                  New activity ↓
                </button>
              ) : null}
            </div>
            <AutopilotPanel state={state} selected={selected} run={run} />
            {autopilotLive ? null : (
              <DecisionDock state={state} selected={selected} run={run} onState={setState} />
            )}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (!text || sendDisabledReason) return;
                const target = {
                  projectId: selected.project.id,
                  workflowId: selected.project.workflowId,
                };
                const needsInput = Boolean(selected.project.needsInput);
                void submitComposerDraft(text, {
                  clear: () => setDraft(""),
                  restore: (value) => setDraft((current) => (current.trim() ? current : value)),
                  current: () => "",
                  send: async (value) => {
                    const sent = await run(() =>
                      needsInput
                        ? window.poundlockDispatch.replyInput(value, target)
                        : window.poundlockDispatch.sendMessage(value, target),
                    );
                    if (sent === undefined) throw new Error("Message was not sent.");
                  },
                });
              }}
            >
              <label htmlFor="composer-input" className="sr-only">
                {selected.project.needsInput
                  ? "Reply to the Project Manager"
                  : "Message the Project Manager"}
              </label>
              <textarea
                id="composer-input"
                value={draft}
                aria-describedby={sendDisabledReason ? "composer-reason" : undefined}
                placeholder={
                  selected.project.needsInput
                    ? "Reply to the Project Manager’s question…"
                    : "Ask the Project Manager, discuss an action, or describe work…"
                }
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="composer-bar">
                <TrustChip
                  mode={effectiveToolTrust(selected.project.policy.toolTrust, state.permissions)}
                  busy={false}
                  onChange={(mode) =>
                    void run(() =>
                      window.poundlockDispatch.updatePolicy(selected.project.id, {
                        ...selected.project.policy,
                        toolTrust: mode,
                      }),
                    )
                  }
                />
                <ReasoningChip
                  state={state}
                  project={selected.project}
                  onChange={(choice) =>
                    void run(() =>
                      window.poundlockDispatch.setConversationReasoning(
                        selected.project.id,
                        choice,
                      ),
                    )
                  }
                />
                <ComposerInfolets state={state} onCompact={compactConversation} />
                <span className="composer-reason" id="composer-reason" aria-live="polite">
                  {sendDisabledReason ?? ""}
                </span>
                <button
                  className="primary"
                  type="submit"
                  disabled={Boolean(sendDisabledReason) || !draft.trim()}
                >
                  Send
                </button>
              </div>
            </form>
          </>
        )}
      </main>
      {fit.rightDocked ? (
        <div {...layout.separatorProps("right", "Resize plan and tasks panel")} />
      ) : null}
      {rightVisible ? (
        <aside
          className={`inspector ${layout.overlay === "right" ? "overlay" : ""}`}
          aria-label="Plan, tasks and evidence"
          style={{ width: fit.right }}
        >
          {selected ? (
            <Inspector
              state={state}
              selected={selected}
              expanded={expandedTasks}
              onToggleTask={(taskId, open) =>
                setExpandedTasks((current) => {
                  const next = new Set(current);
                  if (open) next.add(taskId);
                  else next.delete(taskId);
                  return next;
                })
              }
            />
          ) : (
            <p className="hint">Open a project to see its plan and tasks.</p>
          )}
        </aside>
      ) : null}
      {layout.overlay ? (
        <div className="overlay-scrim" aria-hidden="true" onMouseDown={layout.closeOverlay} />
      ) : null}

      {history ? <HistoryDialog history={history} onClose={() => setHistory(undefined)} /> : null}
      {showNew ? (
        <NewProjectModal
          probe={state.probe}
          integrations={state.integrations}
          onClose={() => setShowNew(false)}
          onCreated={(next) => {
            setState(next);
            setShowNew(false);
          }}
        />
      ) : null}
      {showProjectSettings && selected ? (
        <SettingsModal
          project={selected.project}
          connection={state.connection}
          permissions={state.permissions}
          probe={state.probe}
          integrations={state.integrations}
          onClose={() => setShowProjectSettings(false)}
          onSaved={(next) => setState(next)}
        />
      ) : null}
    </div>
  );
}

function HistoryDialog({ history, onClose }: { history: RunHistoryRecord[]; onClose: () => void }) {
  return (
    <Dialog
      title="History"
      description="Earlier conversations, plans and tasks for this project. Project files are unchanged."
      onClose={onClose}
      className="wide"
    >
      {!history.length ? <p className="hint">Nothing archived yet.</p> : null}
      {history.map((record) => (
        <details className="disclosure history-record" key={record.id}>
          <summary>
            {new Date(record.archivedAt).toLocaleString()} ·{" "}
            {record.plan?.summary.split("\n")[0].slice(0, 90) || "Conversation"}
          </summary>
          {record.plan ? (
            <>
              <h2>Plan · revision {record.plan.revision}</h2>
              <Markdown text={record.plan.summary} />
            </>
          ) : null}
          {record.tasks.length ? (
            <>
              <h2>Tasks</h2>
              <ul className="plain-list">
                {record.tasks.map((task) => (
                  <li key={task.id}>
                    {task.title} ·{" "}
                    {task.status === "applied" ? "Accepted" : task.status.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h2>Conversation</h2>
          {record.messages.map((message) => (
            <div className="msg" key={message.id}>
              <span className="who">{speaker(message.role)}</span>
              <Markdown text={message.text} />
            </div>
          ))}
        </details>
      ))}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

function NewProjectModal({
  probe,
  integrations,
  onClose,
  onCreated,
}: {
  probe: AppStateView["probe"];
  integrations: IntegrationsPublic;
  onClose: () => void;
  onCreated: (state: AppStateView) => void;
}) {
  const [source, setSource] = useState<"folder" | "git">("folder");
  const [name, setName] = useState("");
  // The name follows the chosen folder until the owner types one.
  const [nameTyped, setNameTyped] = useState(false);
  const [folder, setFolder] = useState("");
  const [repository, setRepository] = useState("");
  const [revision, setRevision] = useState("");
  const [gitAccess, setGitAccess] = useState<"none" | ForgeKind>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const githubReady = Boolean(integrations.github?.configured);
  const giteaReady = Boolean(integrations.gitea?.configured);
  const missing =
    source === "folder"
      ? !folder
        ? "Choose a folder to continue."
        : undefined
      : !repository.trim() || !revision.trim()
        ? "Enter the repository URL and a branch or commit."
        : undefined;

  return (
    <Dialog
      title="Add project"
      description="Work happens in that folder, or in a checkout of the repository. Manager notes stay in Poundlock Dispatch, not the repository."
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || missing) return;
          void (async () => {
            setBusy(true);
            setError(undefined);
            try {
              const next =
                source === "folder"
                  ? await window.poundlockDispatch.createFolderProject({
                      folder,
                      name: name || "Project",
                    })
                  : await window.poundlockDispatch.createGitProject({
                      repository,
                      revision,
                      name: name || repository,
                      forge: gitAccess === "none" ? undefined : gitAccess,
                    });
              onCreated(next as AppStateView);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <fieldset className="choice-group">
          <legend>Source</legend>
          <label className={`choice ${source === "folder" ? "selected" : ""}`}>
            <input
              type="radio"
              name="project-source"
              checked={source === "folder"}
              onChange={() => setSource("folder")}
            />
            <span>
              <strong>Folder on this Mac</strong>
              <span className="hint">Open an existing directory in place.</span>
            </span>
          </label>
          <label className={`choice ${source === "git" ? "selected" : ""}`}>
            <input
              type="radio"
              name="project-source"
              checked={source === "git"}
              onChange={() => setSource("git")}
            />
            <span>
              <strong>Git repository</strong>
              <span className="hint">HTTPS URL, then a branch name or a commit.</span>
            </span>
          </label>
        </fieldset>
        {source === "folder" ? (
          <div className="field">
            <span className="field-label">Folder</span>
            <div className="inline-field">
              <span className="path-value">{folder || "No folder chosen"}</span>
              <button
                type="button"
                onClick={() =>
                  void window.poundlockDispatch
                    .chooseFolder()
                    .then((chosen: string | undefined) => {
                      if (!chosen) return;
                      setFolder(chosen);
                      if (!nameTyped) setName(chosen.split("/").pop() || "Project");
                    })
                }
              >
                Choose folder…
              </button>
            </div>
            {folder ? (
              <p className="hint">
                If this folder has a Git remote, attach GitHub or Gitea in Project settings when you
                want to push a pull request.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="repo">Repository URL</label>
              <input
                id="repo"
                value={repository}
                placeholder="https://github.com/example/repo.git"
                onChange={(event) => setRepository(event.target.value)}
              />
              <p className="hint">HTTPS only.</p>
            </div>
            <div className="field">
              <label htmlFor="rev">Branch or commit</label>
              <input
                id="rev"
                value={revision}
                placeholder="main"
                onChange={(event) => setRevision(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="access">Access</label>
              <select
                id="access"
                value={gitAccess}
                onChange={(event) => setGitAccess(event.target.value as "none" | ForgeKind)}
              >
                <option value="none">None — public clone only</option>
                <option value="github" disabled={!githubReady}>
                  {githubReady
                    ? `GitHub (${integrations.github?.username})`
                    : "GitHub — add an account in Settings"}
                </option>
                <option value="gitea" disabled={!giteaReady}>
                  {giteaReady
                    ? `Gitea (${integrations.gitea?.host})`
                    : "Gitea — add an account in Settings"}
                </option>
              </select>
              <p className="hint">
                {gitAccess === "none"
                  ? "No token. Fine for public repositories. Add an account in Settings → Integrations before pushing or opening a pull request."
                  : gitAccess === "github"
                    ? "Uses the GitHub token from Settings for private fetch. Pushing and opening a pull request happen only after you confirm."
                    : "Uses the Gitea token and base URL from Settings. Same capabilities as GitHub."}
              </p>
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="name">Project name</label>
          <input
            id="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameTyped(Boolean(event.target.value));
            }}
          />
        </div>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <span className="hint dialog-reason">{missing ?? ""}</span>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || Boolean(missing)}>
            {busy ? "Adding…" : "Add project"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
