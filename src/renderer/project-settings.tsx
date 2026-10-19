import { describeReach, projectReach } from "@shared/network";
import {
  effectiveToolTrust,
  type PermissionSettings,
  TOOL_TRUST_MODES,
  toolTrustLabel,
} from "@shared/permissions";
import { fixRoundsPerTask, MAX_FIX_ROUNDS_SETTING } from "@shared/policy-limits";
import {
  type CatalogProfile,
  catalogFromProbe,
  catalogMatchesBinding,
  profileDisplayName,
} from "@shared/roles";
import type {
  AppStateView,
  ForgeKind,
  IntegrationsPublic,
  ProjectPolicy,
  ProjectRecord,
  RuntimeCandidate,
} from "@shared/types";
import { projectWebSearch, withSwitch } from "@shared/web-search";
import { useEffect, useState } from "react";
import { Dialog, SaveStatus, useSaveState } from "./dialog";
import { ModelPicker } from "./model-picker";

function commandLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function SettingsModal({
  project,
  connection,
  permissions,
  probe,
  integrations,
  onClose,
  onSaved,
}: {
  project: ProjectRecord;
  connection: AppStateView["connection"];
  permissions: PermissionSettings;
  probe: AppStateView["probe"];
  integrations: IntegrationsPublic;
  onClose: () => void;
  onSaved: (state: AppStateView) => void;
}) {
  const [policy, setPolicy] = useState(project.policy);
  // Folders are granted and removed immediately through the host, never saved with the form.
  const [roots, setRoots] = useState(project.policy.roots ?? []);
  const [commands, setCommands] = useState(project.policy.verification.commands.join("\n"));
  const [discovery, setDiscovery] = useState(probe);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const save = useSaveState();
  const currentForge = project.source.forge;
  const remote =
    project.source.kind === "git" ? project.source.repository : project.source.gitRemote;
  const [forge, setForge] = useState<"" | ForgeKind>(currentForge ?? "");
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const next = await window.poundlockDispatch.refreshServerInfo();
      setDiscovery(next.probe);
      if (!next.probe?.ok) setError(next.probe?.error || "Could not refresh the model list.");
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => setDiscovery(probe), [probe]);
  useEffect(() => {
    if (!probe) void refresh();
  }, []);
  const candidate: ProjectPolicy = {
    ...policy,
    verification: { ...policy.verification, commands: commandLines(commands) },
  };
  const dirty =
    JSON.stringify(candidate) !== JSON.stringify(project.policy) || forge !== (currentForge ?? "");
  const catalog = discovery ? catalogFromProbe(discovery) : [];
  const nameFor = (binding: AppStateView["connection"]["roles"]["manager"]) => {
    if (!binding) return "not selected";
    const found = catalogMatchesBinding(catalog, binding);
    return found ? profileDisplayName(found) : `${binding.profileName} (not currently advertised)`;
  };
  const defaultManagerName = nameFor(connection.roles.manager);
  const defaultWorkerName = nameFor(connection.roles.interactive);
  const trust = effectiveToolTrust(policy.toolTrust, permissions);
  const locked = Boolean(busy) || save.saving;
  return (
    <Dialog
      title="Project settings"
      description={project.name}
      onClose={onClose}
      busy={locked}
      className="project-settings"
    >
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="form-section" aria-labelledby="ps-models">
        <div className="section-head">
          <h2 id="ps-models">Models</h2>
          <button
            type="button"
            className="quiet small"
            disabled={loading || locked}
            onClick={() => void refresh()}
          >
            {loading ? "Loading models…" : "Refresh models"}
          </button>
        </div>
        <p className="hint">
          Each role uses the app default from Settings → Models unless you choose a model for this
          project. The model ladder, destination approvals and reasoning defaults still apply.
        </p>
        <ProjectRoleField
          id="manager"
          label="Project Manager"
          role="manager"
          value={policy.managerModel}
          catalog={catalog}
          defaultName={defaultManagerName}
          disabled={loading || locked}
          hint="Plans, delegates and reviews. A conversation can change its reasoning from the composer."
          onChange={(value) => setPolicy({ ...policy, managerModel: value })}
        />
        <ProjectRoleField
          id="worker"
          label="Worker"
          role="interactive"
          value={policy.workerModel ?? ""}
          catalog={catalog}
          defaultName={defaultWorkerName}
          disabled={loading || locked}
          hint="Small tasks start here. A medium or large task may start on a further local model-ladder rung when this model's context is not enough."
          onChange={(value) => setPolicy({ ...policy, workerModel: value || undefined })}
        />
      </section>
      <section className="form-section" aria-labelledby="ps-permissions">
        <h2 id="ps-permissions">Permissions</h2>
        <div className="field">
          <label htmlFor="tool-trust">Local worker actions</label>
          <select
            id="tool-trust"
            value={policy.toolTrust ?? ""}
            disabled={locked}
            onChange={(event) => {
              const value = event.target.value;
              setPolicy({
                ...policy,
                toolTrust:
                  value === "ask" || value === "assist" || value === "full" ? value : undefined,
              });
            }}
          >
            <option value="">App default — {toolTrustLabel(permissions.defaultMode)}</option>
            {TOOL_TRUST_MODES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <p className="hint">
            <span className="scope-tag">
              {policy.toolTrust ? "Project override" : "App default"}
            </span>{" "}
            Effective: {toolTrustLabel(trust)}. Confirmed internal inference needs no destination
            approval. External inference follows its approval or frontier policy.
          </p>
        </div>
        <label className="field">
          <span>Fix rounds per task</span>
          <select
            value={policy.fixRoundsPerTask === undefined ? "" : String(policy.fixRoundsPerTask)}
            disabled={locked}
            onChange={(event) =>
              setPolicy({
                ...policy,
                fixRoundsPerTask:
                  event.target.value === "" ? undefined : Number(event.target.value),
              })
            }
          >
            <option value="">
              App default ({fixRoundsPerTask(undefined, permissions.fixRoundsPerTask)})
            </option>
            {Array.from({ length: MAX_FIX_ROUNDS_SETTING + 1 }, (_, rounds) => (
              <option key={rounds} value={rounds}>
                {rounds}
              </option>
            ))}
          </select>
          <span className="hint">
            Times the manager may send a reviewed attempt back before the task counts as stuck.
          </span>
        </label>
        <details className="disclosure">
          <summary>Read exceptions ({policy.readGrants?.length ?? 0})</summary>
          <p className="hint">Ignored files and secrets stay excluded unless you choose a file.</p>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setBusy("Choosing file…");
              void window.poundlockDispatch
                .grantRead(project.id)
                .then((next) => {
                  if (next.snapshot)
                    setPolicy((current) => ({
                      ...current,
                      readGrants: next.snapshot!.project.policy.readGrants,
                    }));
                })
                .catch((caught) => setError(String(caught)))
                .finally(() => setBusy(""));
            }}
          >
            Choose an excluded file…
          </button>
          <ul className="read-grants">
            {(policy.readGrants ?? []).map((path) => (
              <li className="read-grant" key={path}>
                <code>{path}</code>
                <button
                  type="button"
                  className="quiet small"
                  aria-label={`Remove read exception ${path}`}
                  disabled={locked}
                  onClick={() =>
                    setPolicy({
                      ...policy,
                      readGrants: policy.readGrants?.filter((value) => value !== path),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
        <details className="disclosure" open={roots.length > 0}>
          <summary>Other folders ({roots.length})</summary>
          <p className="hint">
            Folders outside the project the manager and workers may use, such as another project's
            code to reuse. Workers change files only in a read-and-write folder.
          </p>
          <div className="dock-actions">
            {(["read", "write"] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                disabled={locked}
                onClick={() => {
                  setBusy("Choosing folder…");
                  void window.poundlockDispatch
                    .grantFolder(project.id, mode)
                    .then((next) => setRoots(next.snapshot?.project.policy.roots ?? roots))
                    .catch((caught) => setError(String(caught)))
                    .finally(() => setBusy(""));
                }}
              >
                {mode === "read" ? "Add a read-only folder…" : "Add a read-and-write folder…"}
              </button>
            ))}
          </div>
          <ul className="read-grants">
            {roots.map((root) => (
              <li className="read-grant" key={root.path}>
                <code>{root.path}</code>
                <span className="hint">
                  {root.mode === "write" ? "read and write" : "read-only"}
                  {root.grantedBy === "approval" ? " · allowed on a card" : ""}
                </span>
                <button
                  type="button"
                  className="quiet small"
                  aria-label={`Remove folder ${root.path}`}
                  disabled={locked}
                  onClick={() => {
                    setBusy("Removing folder…");
                    void window.poundlockDispatch
                      .revokeFolder(project.id, root.path)
                      .then((next) => setRoots(next.snapshot?.project.policy.roots ?? []))
                      .catch((caught) => setError(String(caught)))
                      .finally(() => setBusy(""));
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      </section>
      <NetworkSection
        policy={policy}
        locked={locked}
        searchEngine={connection.webSearch?.url}
        onChange={(network) => setPolicy({ ...policy, network })}
      />
      <section className="form-section" aria-labelledby="ps-execution">
        <h2 id="ps-execution">Execution and environment</h2>
        <p className="hint">
          Dispatch selects the project environment from repository evidence: an existing project
          environment first, then the toolchain the repository declares. It asks before installing a
          runtime or changing a lockfile.
        </p>
        <NodeRuntimeField project={project} locked={locked} onSaved={onSaved} />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={policy.mutationCheck !== false}
            disabled={locked}
            onChange={(event) =>
              setPolicy({
                ...policy,
                mutationCheck: event.target.checked ? undefined : false,
              })
            }
          />
          <span>
            Check that tests catch broken behaviour before accepting a task
            <span className="hint">
              Dispatch flips up to two conditions in the task's new code and reruns the checks; a
              change no check notices is sent back once. Each try costs one run of the checks.
            </span>
          </span>
        </label>
        <div className="field">
          <label htmlFor="checks">Verification commands</label>
          <textarea
            id="checks"
            value={commands}
            disabled={locked}
            aria-describedby="checks-help"
            onChange={(event) => setCommands(event.target.value)}
          />
          <p className="hint" id="checks-help">
            One command per line. When empty, Dispatch uses the checks the repository declares after
            setup and records what it runs.
          </p>
        </div>
      </section>
      <section className="form-section" aria-labelledby="ps-repo">
        <h2 id="ps-repo">Repository access</h2>
        {remote ? (
          <div className="field">
            <label htmlFor="forge">Git service account</label>
            <select
              id="forge"
              value={forge}
              disabled={locked}
              onChange={(event) => setForge(event.target.value as "" | ForgeKind)}
            >
              <option value="">Public repository — no account</option>
              <option value="github" disabled={!integrations.github?.configured}>
                GitHub
                {integrations.github?.configured
                  ? ` (${integrations.github.username})`
                  : " — add an account in Settings"}
              </option>
              <option value="gitea" disabled={!integrations.gitea?.configured}>
                Gitea
                {integrations.gitea?.configured
                  ? ` (${integrations.gitea.username})`
                  : " — add an account in Settings"}
              </option>
            </select>
            <p className="hint">{remote}. Pushing changes still requires confirmation.</p>
          </div>
        ) : (
          <p className="hint">
            This folder has no Git remote. No account is needed to work locally.
          </p>
        )}
        <p className="hint">Archive and Remove from Dispatch are in the Project menu.</p>
      </section>
      <footer className="dialog-actions sticky-footer">
        <SaveStatus
          state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
        />
        <button type="button" disabled={locked} onClick={onClose}>
          {dirty ? "Discard and close" : "Close"}
        </button>
        <button
          type="button"
          className="primary"
          disabled={locked || !dirty}
          onClick={() =>
            void save.save(async () => {
              let next = (await window.poundlockDispatch.updatePolicy(
                project.id,
                candidate,
              )) as AppStateView;
              if (forge !== (currentForge ?? ""))
                next = (await window.poundlockDispatch.attachForge(
                  project.id,
                  forge || undefined,
                )) as AppStateView;
              onSaved(next);
              const saved = next.snapshot?.project.policy;
              if (saved) {
                setPolicy(saved);
                setCommands(saved.verification.commands.join("\n"));
              }
            })
          }
        >
          {save.saving ? "Saving…" : "Save changes"}
        </button>
      </footer>
    </Dialog>
  );
}

function NodeRuntimeField({
  project,
  locked,
  onSaved,
}: {
  project: ProjectRecord;
  locked: boolean;
  onSaved: (state: AppStateView) => void;
}) {
  const selected = project.policy.runtimes?.node;
  const [candidates, setCandidates] = useState<RuntimeCandidate[]>();
  const [status, setStatus] = useState("");
  useEffect(() => {
    void window.poundlockDispatch.runtimeCandidates().then(setCandidates, () => setCandidates([]));
  }, []);
  async function choose(directory: string | null | undefined) {
    setStatus("Saving…");
    try {
      onSaved(await window.poundlockDispatch.setProjectRuntime(project.id, "node", directory));
      setStatus(directory === null ? "Cleared." : "Saved.");
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    }
  }
  return (
    <div className="field">
      <span className="field-label" id="node-runtime-label">
        Node runtime
      </span>
      <p className="hint">
        Workers never inherit your shell PATH. If Node is installed only through NVM, select a
        trusted version for this project. Its directory is used for commands, checks and environment
        setup.
      </p>
      <div className="inline-field" role="group" aria-labelledby="node-runtime-label">
        <span className="path-value">
          {selected ?? "None selected (system tool directories only)"}
        </span>
        {candidates?.length ? (
          <select
            aria-label="Detected Node runtimes"
            disabled={locked}
            value=""
            onChange={(event) => event.target.value && void choose(event.target.value)}
          >
            <option value="">Use a detected version…</option>
            {candidates.map((item) => (
              <option key={item.directory} value={item.directory}>
                Node {item.version} ({item.source})
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" disabled={locked} onClick={() => void choose(undefined)}>
          Choose folder…
        </button>
        {selected ? (
          <button
            type="button"
            className="quiet"
            disabled={locked}
            onClick={() => void choose(null)}
          >
            Clear
          </button>
        ) : null}
      </div>
      {status ? (
        <p className="hint" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}

/** One role override, laid out like Settings → Models: app default unless a model is chosen here. */
function ProjectRoleField({
  id,
  label,
  role,
  value,
  catalog,
  defaultName,
  disabled,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  role: "manager" | "interactive";
  value: string;
  catalog: CatalogProfile[];
  defaultName: string;
  disabled: boolean;
  hint: string;
  onChange: (value: string) => void;
}) {
  const chosen = value
    ? catalogMatchesBinding(catalog, {
        profileId: value,
        profileName: value,
        source: "interactive",
      })
    : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <ModelPicker
        id={id}
        value={value}
        role={role}
        catalog={catalog}
        disabled={disabled}
        emptyLabel={`App default — ${defaultName}`}
        onChange={onChange}
      />
      <p className="hint">
        <span className="scope-tag">{value ? "Project override" : "App default"}</span> Effective:{" "}
        {value
          ? chosen
            ? profileDisplayName(chosen)
            : `${value} (not currently advertised — Dispatch will not substitute another model)`
          : defaultName}
        . {hint}
      </p>
    </div>
  );
}

/** The project's two network switches (ADR 015), and whether its agents search the web. */
function NetworkSection({
  policy,
  locked,
  searchEngine,
  onChange,
}: {
  policy: ProjectPolicy;
  locked: boolean;
  searchEngine?: string;
  onChange: (network: ProjectPolicy["network"]) => void;
}) {
  const reach = projectReach(policy);
  return (
    <section className="form-section" aria-labelledby="ps-network">
      <h2 id="ps-network">Network</h2>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={reach.internet}
          disabled={locked}
          onChange={(event) => onChange(withSwitch(policy, { internet: event.target.checked }))}
        />
        <span>Internet</span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={reach.localNetwork}
          disabled={locked}
          onChange={(event) => onChange(withSwitch(policy, { localNetwork: event.target.checked }))}
        />
        <span>Local network</span>
      </label>
      <p className="hint">
        {describeReach(reach)}. These decide what every command a worker runs on this Mac can
        connect to, whatever the permission mode. Local network means this Mac&apos;s own services
        and your network&apos;s devices, such as a router or Home Assistant. With only one switch
        on, programs reach the network through a local proxy, which most developer tools use; SSH
        and other raw connections need both on.
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={projectWebSearch(policy)}
          disabled={locked || !reach.internet}
          onChange={(event) => onChange(withSwitch(policy, { webSearch: event.target.checked }))}
        />
        <span>Web search for the manager and Planner</span>
      </label>
      <p className="hint">
        {searchEngine
          ? `Searches go through your search engine at ${searchEngine}. `
          : "Set up a search engine in Settings first; until then nothing is searched. "}
        Search queries and the pages read leave your network, so the agents search only for public
        facts, never with code, file paths, project names or secrets, and every search is recorded.
        Needs Internet on.
      </p>
    </section>
  );
}
