import { APPEARANCE_THEMES, type AppearanceTheme } from "@shared/appearance";
import {
  effectiveToolTrust,
  type SavedPermission,
  TOOL_TRUST_MODES,
  toolTrustLabel,
} from "@shared/permissions";
import { fixRoundsPerTask, MAX_FIX_ROUNDS_SETTING } from "@shared/policy-limits";
import { offeredReasoning, reasoningLabel } from "@shared/reasoning";
import {
  bindingForProfile,
  type CatalogProfile,
  canonicalRoleMap,
  catalogFromProbe,
  catalogMatchesBinding,
  destinationLabel,
  effectiveDestination,
  endpointKindLabel,
  profileDisplayName,
  ROLE_DEFINITIONS,
  type RoleMap,
  roleMapReady,
  routeRevisionChanged,
} from "@shared/roles";
import { STATUS_INFOLET_CATALOG } from "@shared/status-infolets";
import themeRoles from "@shared/theme.json";
import {
  type AppStateView,
  type DataDestination,
  EXAMPLE_CONTROLLER_URL,
  type ProfilePreference,
  type ReasoningChoice,
} from "@shared/types";
import type { ComposerInfoletId } from "@shared/ui-preferences";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { SaveStatus, useSaveState } from "./dialog";
import { SettingsEscalation } from "./escalation-settings";
import { ModelPicker } from "./model-picker";

export type SettingsNav =
  | "connection"
  | "models-manager"
  | "models-worker"
  | "models-verifier"
  | "models-ladder"
  | "models-autocomplete"
  | "permissions"
  | "appearance"
  | "integrations";

interface SettingsNavItem {
  id: SettingsNav;
  label: string;
  /** Consecutive items sharing a group render nested under one collapsible heading. */
  group?: string;
}

const MODELS_GROUP = "Models and routing";

/** Models and routing is a group in the settings sidebar: each role gets its own fully expanded panel. */
const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { id: "connection", label: "Connection" },
  { id: "models-manager", label: "Manager", group: MODELS_GROUP },
  { id: "models-worker", label: "Worker", group: MODELS_GROUP },
  { id: "models-verifier", label: "Verifier", group: MODELS_GROUP },
  { id: "models-ladder", label: "Model ladder", group: MODELS_GROUP },
  { id: "models-autocomplete", label: "Autocomplete", group: MODELS_GROUP },
  { id: "permissions", label: "Permissions" },
  { id: "appearance", label: "Appearance" },
  { id: "integrations", label: "Integrations" },
];

/** Groups consecutive same-`group` items together; ungrouped items pass through unchanged. */
/**
 * Output budget offered for a manager running on this computer. It was 2,048,
 * which is exactly the limit that truncated a detailed plan in the workstation
 * qualification (a complete one needed ~4,200 tokens); 8,192 is the ceiling the
 * qualified local manager publishes.
 */
const DEFAULT_LOCAL_MANAGER_OUTPUT_TOKENS = 8192;

function groupSettingsNavItems(
  items: SettingsNavItem[],
): Array<
  { group: string; items: SettingsNavItem[] } | { group?: undefined; item: SettingsNavItem }
> {
  const rows: Array<
    { group: string; items: SettingsNavItem[] } | { group?: undefined; item: SettingsNavItem }
  > = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (item.group && last && "group" in last && last.group === item.group) last.items.push(item);
    else if (item.group) rows.push({ group: item.group, items: [item] });
    else rows.push({ item });
  }
  return rows;
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

async function testConnection(
  address: string,
  token: string,
  roles: RoleMap,
): Promise<AppStateView> {
  await window.poundlockDispatch.connectionSave({ url: address.trim(), token, roles });
  return (await window.poundlockDispatch.connectionTest()) as AppStateView;
}

export function SetupWizard({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const [step, setStep] = useState<"connection" | "roles">(
    state.connection.tokenConfigured && state.probe?.ok ? "roles" : "connection",
  );
  const [address, setAddress] = useState(state.connection.url);
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState(state.probe);
  useEffect(() => setProbe(state.probe), [state.probe]);
  const [roles, setRoles] = useState<RoleMap>(state.connection.roles);
  const [preferences, setPreferences] = useState<ProfilePreferences>(
    () => state.connection.profiles ?? {},
  );
  useEffect(() => setPreferences(state.connection.profiles ?? {}), [state.connection.profiles]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mapped = roleMapReady(roles);
  const catalog = useMemo(() => (probe ? catalogFromProbe(probe) : []), [probe]);

  return (
    <main className="setup-screen">
      <div className="setup-card">
        <div className="brand">Poundlock Dispatch</div>
        <ol className="step-row" aria-label="Setup steps">
          <li aria-current={step === "connection" ? "step" : undefined}>
            <span className={`step-dot ${step === "connection" ? "current" : "done"}`}>1</span>
            <span className="step-label">Connection</span>
          </li>
          <li aria-current={step === "roles" ? "step" : undefined}>
            <span className={`step-dot ${step === "roles" ? "current" : ""}`}>2</span>
            <span className="step-label">Models</span>
          </li>
        </ol>
        {step === "connection" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !address.trim()) return;
              void (async () => {
                setBusy(true);
                setError(undefined);
                try {
                  const tested = await testConnection(address, token, roles);
                  setProbe(tested.probe);
                  onState(tested);
                  if (tested.probe?.ok) {
                    setRoles(tested.connection.roles);
                    setStep("roles");
                  }
                } catch (caught) {
                  setError(message(caught));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <h1 className="page-title">Connect to Poundlock</h1>
            <p className="page-intro">
              Controller address and one application token from Access. LiteLLM and other gateways
              stay on Poundlock.
            </p>
            <ConnectionFields
              url={state.connection.url}
              address={address}
              token={token}
              tokenConfigured={state.connection.tokenConfigured}
              onAddress={setAddress}
              onToken={setToken}
            />
            {error ? (
              <div className="notice error" role="alert">
                {error}
              </div>
            ) : null}
            {probe?.error ? (
              <div className="notice error" role="alert">
                {probe.error}
                {probe.hint ? ` ${probe.hint}` : ""}
              </div>
            ) : null}
            <div className="form-actions">
              <button type="submit" className="primary" disabled={busy || !address.trim()}>
                {busy ? "Testing…" : "Test connection"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <h1 className="page-title">Choose default models</h1>
            <p className="page-intro">
              Assign the manager and interactive worker explicitly. The same underlying profile may
              fill both roles only when you choose it for each.
            </p>
            {probe?.ok ? (
              <div className="notice" role="status">
                Connected to Poundlock {probe.version || ""}. Choose your defaults, then continue.
              </div>
            ) : null}
            <RoleMapFields
              catalog={catalog}
              probe={probe}
              roles={roles}
              onChange={setRoles}
              preferences={preferences}
              onPreferencesChange={setPreferences}
            />
            {error ? (
              <div className="notice error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="form-actions">
              <button type="button" disabled={busy} onClick={() => setStep("connection")}>
                Back
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !mapped}
                onClick={() => {
                  void (async () => {
                    setBusy(true);
                    setError(undefined);
                    try {
                      onState(
                        await window.poundlockDispatch.saveModels(canonicalRoleMap(roles, catalog)),
                      );
                    } catch (caught) {
                      setError(message(caught));
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                Continue
              </button>
              {!mapped ? (
                <span className="hint">Choose Manager and Worker to continue.</span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export function SettingsPage({
  state,
  nav,
  onNav,
  onState,
  onBack,
  approvals,
}: {
  state: AppStateView;
  nav: SettingsNav;
  onNav: (nav: SettingsNav) => void;
  onState: (state: AppStateView) => void;
  onBack: () => void;
  approvals?: ReactNode;
}) {
  return (
    <div className="settings-app">
      <nav className="settings-nav" aria-label="Settings sections">
        <button type="button" className="settings-back" onClick={onBack}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M10 3L5 8l5 5" />
          </svg>
          Back to projects
        </button>
        <p className="settings-title">Settings</p>
        <ul>
          {groupSettingsNavItems(SETTINGS_NAV_ITEMS).map((row) =>
            "item" in row ? (
              <li key={row.item.id}>
                <button
                  type="button"
                  className={`settings-nav-item ${nav === row.item.id ? "active" : ""}`}
                  aria-current={nav === row.item.id ? "page" : undefined}
                  onClick={() => onNav(row.item.id)}
                >
                  {row.item.label}
                </button>
              </li>
            ) : (
              <li key={row.group} className="settings-nav-group">
                <p className="settings-nav-group-title">{row.group}</p>
                <ul>
                  {row.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`settings-nav-item settings-nav-subitem ${nav === item.id ? "active" : ""}`}
                        aria-current={nav === item.id ? "page" : undefined}
                        onClick={() => onNav(item.id)}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ),
          )}
        </ul>
      </nav>
      <main className="settings-panel">
        <div className="settings-panel-inner">
          {approvals ? <div className="settings-approvals">{approvals}</div> : null}
          {state.notice?.kind === "error" ? (
            <div className="notice error" role="alert">
              {state.notice.text}
            </div>
          ) : null}
          {nav === "connection" ? <SettingsConnection state={state} onState={onState} /> : null}
          {nav === "models-manager" ? (
            <SettingsModelsManager state={state} onState={onState} />
          ) : null}
          {nav === "models-worker" ? (
            <SettingsModelsWorker state={state} onState={onState} />
          ) : null}
          {nav === "models-verifier" ? (
            <SettingsModelsVerifier state={state} onState={onState} />
          ) : null}
          {nav === "models-ladder" ? <SettingsEscalation state={state} onState={onState} /> : null}
          {nav === "models-autocomplete" ? (
            <SettingsModelsAutocomplete state={state} onState={onState} />
          ) : null}
          {nav === "permissions" ? <SettingsPermissions state={state} onState={onState} /> : null}
          {nav === "appearance" ? <SettingsAppearance state={state} onState={onState} /> : null}
          {nav === "integrations" ? <SettingsIntegrations state={state} onState={onState} /> : null}
        </div>
      </main>
    </div>
  );
}

function SettingsConnection({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const [address, setAddress] = useState(state.connection.url);
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState(state.probe);
  useEffect(() => setProbe(state.probe), [state.probe]);
  const save = useSaveState();
  const dirty = address.trim() !== state.connection.url || Boolean(token);
  return (
    <>
      <h1 className="page-title">Connection</h1>
      <p className="page-intro">One Poundlock controller address and one Access token.</p>
      <form
        className="form-section"
        aria-labelledby="conn-controller"
        onSubmit={(event) => {
          event.preventDefault();
          if (save.saving || !address.trim()) return;
          void save.save(async () => {
            const tested = await testConnection(address, token, state.connection.roles);
            setProbe(tested.probe);
            onState(tested);
            setToken("");
            if (!tested.probe?.ok)
              throw new Error(
                `${tested.probe?.error ?? "The controller did not respond."}${tested.probe?.hint ? ` ${tested.probe.hint}` : ""}`,
              );
          });
        }}
      >
        <h2 id="conn-controller">Controller</h2>
        <ConnectionFields
          url={state.connection.url}
          address={address}
          token={token}
          tokenConfigured={state.connection.tokenConfigured}
          onAddress={setAddress}
          onToken={setToken}
        />
        {probe?.ok && !dirty ? (
          <p className="notice ok" role="status">
            Connected to Poundlock {probe.version || ""}.
          </p>
        ) : null}
        {probe?.error && save.state.kind !== "error" ? (
          <p className="notice error">
            {probe.error}
            {probe.hint ? ` ${probe.hint}` : ""}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={save.saving || !address.trim()}>
            {save.saving ? "Testing…" : dirty ? "Save and test" : "Test connection"}
          </button>
          <SaveStatus
            state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
            savedText="Connection saved and tested"
          />
        </div>
      </form>
      <ServerInformation state={state} onState={onState} />
      <WebSearchSettings state={state} onState={onState} />
    </>
  );
}

/** The owner's SearXNG instance, which projects that turn web search on search through. */
function WebSearchSettings({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const save = useSaveState();
  const saved = state.connection.webSearch?.url ?? "";
  const [url, setUrl] = useState(saved);
  const dirty = url.trim().replace(/\/+$/, "") !== saved;
  return (
    <form
      className="form-section"
      aria-labelledby="conn-web-search"
      onSubmit={(event) => {
        event.preventDefault();
        void save.save(async () =>
          onState(await window.poundlockDispatch.saveWebSearch(url.trim() || null)),
        );
      }}
    >
      <h2 id="conn-web-search">Web search</h2>
      <div className="field">
        <label htmlFor="web-search-url">Search engine (SearXNG)</label>
        <input
          id="web-search-url"
          value={url}
          placeholder="http://127.0.0.1:8888"
          aria-describedby="web-search-help"
          onChange={(event) => setUrl(event.target.value)}
        />
        <p className="hint" id="web-search-help">
          Your own SearXNG instance, with its JSON output turned on. A project uses it only when its
          Web search switch is on, for the manager and the Planner. Leave it empty to turn web
          search off everywhere.
        </p>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={save.saving || !dirty}>
          {save.saving ? "Saving…" : "Save"}
        </button>
        <SaveStatus
          state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
          savedText="Search engine saved"
        />
      </div>
    </form>
  );
}

function ServerInformation({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const save = useSaveState();
  const refreshing = save.saving || state.discovery?.refreshing;
  const probe = state.probe;
  return (
    <section className="form-section" aria-labelledby="conn-server">
      <h2 id="conn-server">Server information</h2>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          {probe?.ok
            ? `Connected${probe.version ? ` · Poundlock ${probe.version}` : ""}`
            : probe?.error
              ? "Unavailable"
              : "Not checked yet"}
        </dd>
        <dt>Profiles</dt>
        <dd>
          {probe
            ? `${probe.interactiveModels.length} interactive · ${probe.durableModels.length} job`
            : "Unknown"}
        </dd>
        <dt>Last updated</dt>
        <dd>
          {state.discovery?.updatedAt
            ? new Date(state.discovery.updatedAt).toLocaleString()
            : "Refreshes when the app opens"}
        </dd>
        {probe?.managedIdentities?.length ? (
          <>
            <dt>Gateway identity</dt>
            <dd>{probe.managedIdentities.map((item) => item.status).join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {probe?.error ? (
        <p className="notice error">
          {probe.error}
          {state.discovery?.updatedAt ? " Showing the last available information." : ""}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          disabled={Boolean(refreshing) || !state.connection.tokenConfigured}
          onClick={() =>
            void save.save(async () => onState(await window.poundlockDispatch.refreshServerInfo()))
          }
        >
          {refreshing ? "Refreshing…" : "Refresh server info"}
        </button>
        {!state.connection.tokenConfigured ? (
          <span className="hint">Save a token first.</span>
        ) : (
          <SaveStatus state={save.state} savedText="Refreshed" />
        )}
      </div>
    </section>
  );
}

/**
 * One role's app-default page: title, plain-language description, the model picker with its
 * inline per-profile preferences, and its own save action. Manager and Worker are required for
 * every conversation turn; Autocomplete stays optional until set.
 */
function RoleDefaultsPage({
  state,
  onState,
  roleId,
  title,
  description,
  children,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
  roleId: "manager" | "interactive" | "snippet" | "verifier";
  title: string;
  description: string;
  children?: ReactNode;
}) {
  const [roles, setRoles] = useState<RoleMap>(state.connection.roles);
  const [preferences, setPreferences] = useState<ProfilePreferences>(
    () => state.connection.profiles ?? {},
  );
  useEffect(() => setPreferences(state.connection.profiles ?? {}), [state.connection.profiles]);
  const save = useSaveState();
  const catalog = useMemo(() => (state.probe ? catalogFromProbe(state.probe) : []), [state.probe]);
  const mapped = roleMapReady(roles);
  const dirty = JSON.stringify(roles) !== JSON.stringify(state.connection.roles);
  const saved = state.connection.roles[roleId];
  const live = saved ? catalogMatchesBinding(catalog, saved) : undefined;
  // Poundlock changed where this profile sends data since it was approved. Saving
  // approves the route shown now; until then Dispatch refuses to send project context.
  const routeChanged = routeRevisionChanged(saved, live);
  return (
    <>
      <h1 className="page-title">{title}</h1>
      <p className="page-intro">{description}</p>
      <section className="form-section" aria-label={`${title} model`}>
        {!state.probe?.ok && catalog.length === 0 ? (
          <p className="notice">
            No profiles loaded. Refresh server information under Connection to list them.
          </p>
        ) : null}
        <RoleModelField
          roleId={roleId}
          roles={roles}
          catalog={catalog}
          probe={state.probe}
          onChange={setRoles}
          preferences={preferences}
          onPreferencesChange={setPreferences}
        />
        {routeChanged && live ? (
          <p className="notice" role="status">
            Poundlock changed the route for {profileDisplayName(live)} since you approved it
            (destination: {destinationLabel(live.dataDestination)}). Projects using it are paused
            until you approve the current route.
          </p>
        ) : null}
        <div className="form-actions">
          <button
            type="button"
            className="primary"
            disabled={save.saving || !mapped || !(dirty || routeChanged)}
            onClick={() =>
              void save.save(async () => {
                const next = await window.poundlockDispatch.saveModels(
                  canonicalRoleMap(roles, catalog),
                );
                // Saving normalizes bindings (route revision, names); adopt the saved
                // form so the page is clean again instead of permanently "unsaved".
                setRoles(next.connection.roles);
                onState(next);
              })
            }
          >
            {save.saving ? "Saving…" : routeChanged && !dirty ? "Approve current route" : "Save"}
          </button>
          <SaveStatus
            state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
          />
          {!mapped ? <span className="field-error">Manager and Worker are required.</span> : null}
        </div>
      </section>
      {children}
    </>
  );
}

function SettingsModelsManager({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  return (
    <RoleDefaultsPage
      state={state}
      onState={onState}
      roleId="manager"
      title="Manager"
      description="Plans the project, splits it into tasks and reviews what workers produce, on every conversation turn. Give it a capable model with a large context — change it if plans stop holding up or a task's history no longer fits. The same profile can also serve as Worker if you choose it there too."
    >
      <ProjectOverridesSection state={state} />
      <LocalManagerSettings state={state} onState={onState} />
    </RoleDefaultsPage>
  );
}

function SettingsModelsWorker({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  return (
    <RoleDefaultsPage
      state={state}
      onState={onState}
      roleId="interactive"
      title="Worker"
      description="Implements each task in your project folder — edits files, runs commands, and tests its own work. Every small task starts here; the model ladder moves bigger or repeatedly failing tasks to a stronger model. A good worker model is fast and reliable in tight edit-and-test loops."
    />
  );
}

function SettingsModelsVerifier({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  return (
    <RoleDefaultsPage
      state={state}
      onState={onState}
      roleId="verifier"
      title="Verifier"
      description="A second opinion from your strongest model. It reviews each new plan against what you asked for before you approve it, and at the end of each round checks, read-only, that the accepted code and tests really show every requirement marked done. It runs a few times per round with a small context, so a slower or costlier model is affordable here. Optional: unset, the Worker does the round-end check and plans are not reviewed."
    />
  );
}

function SettingsModelsAutocomplete({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  return (
    <RoleDefaultsPage
      state={state}
      onState={onState}
      roleId="snippet"
      title="Autocomplete"
      description="A tiny fill-in-the-middle model for editor-style completions — not for planning or full tasks. Optional: leave it unset unless you have a profile built specifically for autocomplete."
    />
  );
}

function ProjectOverridesSection({ state }: { state: AppStateView }) {
  const catalog = useMemo(() => (state.probe ? catalogFromProbe(state.probe) : []), [state.probe]);
  const overrides = state.projects.filter(
    (project) => !project.archived && project.policy.managerModel,
  );
  const nameOf = (profileId: string) => {
    const found = catalogMatchesBinding(catalog, {
      profileId,
      profileName: profileId,
      source: "interactive",
    });
    return found ? profileDisplayName(found) : `${profileId} (unavailable)`;
  };
  return (
    <section className="form-section" aria-labelledby="roles-overrides">
      <h2 id="roles-overrides">Project overrides</h2>
      {overrides.length ? (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Setting</th>
              <th scope="col">Effective</th>
            </tr>
          </thead>
          <tbody>
            {overrides.flatMap((project) => {
              const rows: Array<[string, string]> = [];
              if (project.policy.managerModel)
                rows.push(["Project Manager", nameOf(project.policy.managerModel)]);
              return rows.map(([setting, effective]) => (
                <tr key={`${project.id}:${setting}`}>
                  <td>{project.name}</td>
                  <td>{setting}</td>
                  <td>{effective}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      ) : (
        <p className="hint">
          Every project uses the app defaults. Change a project in its Project settings.
        </p>
      )}
    </section>
  );
}

function LocalManagerSettings({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const currentLocal = state.connection.localManager;
  const [localEnabled, setLocalEnabled] = useState(currentLocal?.enabled ?? false);
  const [localUrl, setLocalUrl] = useState(currentLocal?.url ?? "http://127.0.0.1:11434");
  const [localToken, setLocalToken] = useState("");
  const [localModel, setLocalModel] = useState(currentLocal?.model ?? "");
  const [localContext, setLocalContext] = useState(currentLocal?.contextTokens ?? 32768);
  const [localOutput, setLocalOutput] = useState(
    currentLocal?.maxOutputTokens ?? DEFAULT_LOCAL_MANAGER_OUTPUT_TOKENS,
  );
  const [testResult, setTestResult] = useState<string>();
  const save = useSaveState();
  const test = useSaveState();
  const localSettings = {
    enabled: localEnabled,
    url: localUrl,
    token: localToken,
    model: localModel,
    contextTokens: localContext,
    maxOutputTokens: localOutput,
  };
  const dirty =
    localEnabled !== (currentLocal?.enabled ?? false) ||
    (localEnabled &&
      (localUrl !== (currentLocal?.url ?? "http://127.0.0.1:11434") ||
        localModel !== (currentLocal?.model ?? "") ||
        localContext !== (currentLocal?.contextTokens ?? 32768) ||
        localOutput !== (currentLocal?.maxOutputTokens ?? DEFAULT_LOCAL_MANAGER_OUTPUT_TOKENS) ||
        Boolean(localToken)));
  const busy = save.saving || test.saving;
  return (
    <section className="form-section" aria-labelledby="roles-local">
      <h2 id="roles-local">Project Manager on this computer</h2>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={localEnabled}
          disabled={busy}
          onChange={(event) => setLocalEnabled(event.target.checked)}
        />
        <span>
          Use a model running on this computer for the Project Manager
          <span className="hint">
            Poundlock remains required for workers, and frontier models still come from Poundlock.
            Only the manager connects to a loopback model server.
          </span>
        </span>
      </label>
      {localEnabled ? (
        <>
          <div className="field">
            <label htmlFor="local-manager-url">Local server address</label>
            <input
              id="local-manager-url"
              value={localUrl}
              placeholder="http://127.0.0.1:11434"
              onChange={(event) => setLocalUrl(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="local-manager-token">Local server token</label>
            <input
              id="local-manager-token"
              type="password"
              autoComplete="off"
              value={localToken}
              placeholder={currentLocal?.tokenConfigured ? "Saved — paste to replace" : "Optional"}
              onChange={(event) => setLocalToken(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="local-manager-model">Model ID</label>
            <input
              id="local-manager-model"
              value={localModel}
              aria-invalid={!localModel.trim()}
              onChange={(event) => setLocalModel(event.target.value)}
            />
            {!localModel.trim() ? <p className="field-error">Enter the model ID.</p> : null}
          </div>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="local-context">Context tokens</label>
              <input
                id="local-context"
                type="number"
                min={4096}
                step={1024}
                value={localContext}
                onChange={(event) => setLocalContext(Number(event.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="local-output">Maximum output tokens</label>
              <input
                id="local-output"
                type="number"
                min={256}
                step={256}
                value={localOutput}
                onChange={(event) => setLocalOutput(Number(event.target.value))}
              />
            </div>
          </div>
        </>
      ) : null}
      <div className="form-actions">
        {localEnabled ? (
          <button
            type="button"
            disabled={busy || !localUrl.trim() || !localModel.trim()}
            onClick={() =>
              void test.save(async () => {
                setTestResult(undefined);
                const result = await window.poundlockDispatch.testLocalManager(localSettings);
                const reported = [
                  result.reportedContextTokens
                    ? `${result.reportedContextTokens.toLocaleString()} context`
                    : undefined,
                  result.reportedMaxOutputTokens
                    ? `${result.reportedMaxOutputTokens.toLocaleString()} output`
                    : undefined,
                ].filter(Boolean);
                setTestResult(
                  `Connected to ${result.model}${reported.length ? ` · ${reported.join(" · ")}` : ""}.`,
                );
              })
            }
          >
            {test.saving ? "Testing…" : "Test"}
          </button>
        ) : null}
        <button
          type="button"
          className="primary"
          disabled={busy || !dirty || (localEnabled && (!localUrl.trim() || !localModel.trim()))}
          onClick={() =>
            void save.save(async () => {
              onState(await window.poundlockDispatch.saveLocalManager(localSettings));
              setLocalToken("");
            })
          }
        >
          {save.saving ? "Saving…" : "Save manager source"}
        </button>
        <SaveStatus
          state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
          savedText={localEnabled ? "Local manager saved" : "Using the Poundlock manager"}
        />
      </div>
      {testResult ? (
        <p className="notice ok" role="status">
          {testResult}
        </p>
      ) : null}
      {test.state.kind === "error" ? (
        <p className="notice error" role="alert">
          Test failed: {test.state.message}
        </p>
      ) : null}
    </section>
  );
}

function themeLabel(theme: AppearanceTheme): string {
  switch (theme) {
    case "system":
      return "Match system";
    case "latte":
      return "Latte (light)";
    case "frappe":
      return "Frappé";
    case "macchiato":
      return "Macchiato";
    case "mocha":
      return "Mocha (dark)";
  }
}

function themeHint(theme: Exclude<AppearanceTheme, "system">): string {
  return themeRoles.flavours[theme].dark ? "Dark" : "Light";
}

/**
 * The flavour's own colours, so a choice is seen rather than recalled: canvas,
 * panel, accents and the three states a glance most depends on.
 */
function ThemeSwatch({ theme }: { theme: AppearanceTheme }) {
  const flavours: Array<Exclude<AppearanceTheme, "system">> =
    theme === "system" ? ["mocha", "latte"] : [theme];
  return (
    <span className="theme-swatch" aria-hidden="true">
      {flavours.map((flavour) => {
        const roles = themeRoles.flavours[flavour].roles;
        return (
          <span key={flavour} className="theme-swatch-strip" style={{ background: roles.canvas }}>
            {[
              roles.s2,
              roles.accent,
              roles["accent-2"],
              roles["state-ok"],
              roles["state-review"],
              roles["state-fault"],
            ].map((colour, index) => (
              <span key={index} style={{ background: colour }} />
            ))}
          </span>
        );
      })}
    </span>
  );
}

function SettingsAppearance({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const enabled = new Set(state.ui.composerInfolets);
  const save = useSaveState();
  const themeSave = useSaveState();
  function persist(next: {
    composerInfolets?: ComposerInfoletId[];
    desktopNotifications?: boolean;
  }) {
    void save.save(async () =>
      onState(
        await window.poundlockDispatch.saveUiPreferences({
          composerInfolets: next.composerInfolets ?? state.ui.composerInfolets,
          desktopNotifications: next.desktopNotifications ?? state.ui.desktopNotifications,
        }),
      ),
    );
  }
  return (
    <>
      <h1 className="page-title">Appearance</h1>
      <p className="page-intro">
        These preferences save as soon as you change them. The theme is shared with the terminal
        client on this machine, and follows your system's reduced-motion setting.
      </p>
      <section className="form-section" aria-labelledby="appearance-theme">
        <h2 id="appearance-theme">Theme</h2>
        <div className="theme-choices">
          {APPEARANCE_THEMES.map((theme) => (
            <label
              key={theme}
              className={`choice theme-choice${state.appearance.theme === theme ? " selected" : ""}`}
            >
              <input
                type="radio"
                name="appearance-theme"
                checked={state.appearance.theme === theme}
                disabled={themeSave.saving}
                onChange={() =>
                  void themeSave.save(async () =>
                    onState(await window.poundlockDispatch.saveAppearance({ theme })),
                  )
                }
              />
              <span className="theme-choice-text">
                <strong>{themeLabel(theme)}</strong>
                <span className="hint">
                  {theme === "system" ? "Mocha or Latte, following this Mac." : themeHint(theme)}
                </span>
              </span>
              <ThemeSwatch theme={theme} />
            </label>
          ))}
        </div>
        <SaveStatus state={themeSave.state} savedText="Theme saved" />
      </section>
      <section className="form-section" aria-labelledby="appearance-notify">
        <h2 id="appearance-notify">Notifications</h2>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={state.ui.desktopNotifications}
            disabled={save.saving}
            onChange={(event) => persist({ desktopNotifications: event.target.checked })}
          />
          <span>
            Notify this computer when a project needs you
            <span className="hint">
              For example, when a plan or an action is waiting for approval.
            </span>
          </span>
        </label>
      </section>
      <section className="form-section" aria-labelledby="appearance-composer">
        <h2 id="appearance-composer">Composer status</h2>
        {STATUS_INFOLET_CATALOG.map((item) => (
          <label key={item.id} className="checkbox-row">
            <input
              type="checkbox"
              checked={enabled.has(item.id)}
              disabled={save.saving}
              onChange={(event) =>
                persist({
                  composerInfolets: event.target.checked
                    ? [...new Set([...state.ui.composerInfolets, item.id])]
                    : state.ui.composerInfolets.filter((id) => id !== item.id),
                })
              }
            />
            <span>
              Show {item.label.toLowerCase()} next to Send
              <span className="hint">
                {item.description} Hidden until there is something to show.
              </span>
            </span>
          </label>
        ))}
      </section>
      <SaveStatus state={save.state} savedText="Preference saved" />
    </>
  );
}

function SettingsPermissions({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const save = useSaveState();
  const current = state.permissions.defaultMode;
  const projects = state.projects.filter((project) => !project.archived);
  return (
    <>
      <h1 className="page-title">Permissions</h1>
      <p className="page-intro">
        How Dispatch treats local worker actions on this computer. The Project Manager never gets a
        shell or file writer. External inference follows its destination approval and frontier
        policy, including in Full access.
      </p>
      <fieldset className="form-section" aria-describedby="perm-routine-help">
        <legend>
          <h2>App default for worker actions</h2>
        </legend>
        <p className="hint" id="perm-routine-help">
          Routine development — file edits, environment setup, dependency installation and checks —
          stays inside the project. Destructive, outside or uncontained actions always ask. Saves
          immediately.
        </p>
        {TOOL_TRUST_MODES.map((item) => (
          <label key={item.id} className={`choice ${current === item.id ? "selected" : ""}`}>
            <input
              type="radio"
              name="default-trust"
              checked={current === item.id}
              disabled={save.saving}
              onChange={() =>
                void save.save(async () =>
                  onState(
                    (await window.poundlockDispatch.savePermissions({
                      ...state.permissions,
                      defaultMode: item.id,
                    })) as AppStateView,
                  ),
                )
              }
            />
            <span>
              <strong>{item.label}</strong>
              <span className="hint">{item.hint}</span>
            </span>
          </label>
        ))}
        <SaveStatus state={save.state} savedText="Default saved" />
      </fieldset>
      <fieldset className="form-section" aria-describedby="fix-rounds-help">
        <legend>
          <h2>Fix rounds per task</h2>
        </legend>
        <p className="hint" id="fix-rounds-help">
          How many times the manager may send a reviewed attempt back to its worker before the task
          counts as stuck. An attempt that produced nothing usable does not use a round. A project
          can override this in its settings. Saves immediately.
        </p>
        <div className="field">
          <select
            aria-label="Fix rounds per task"
            value={String(fixRoundsPerTask(undefined, state.permissions.fixRoundsPerTask))}
            disabled={save.saving}
            onChange={(event) =>
              void save.save(async () =>
                onState(
                  (await window.poundlockDispatch.savePermissions({
                    ...state.permissions,
                    fixRoundsPerTask: Number(event.target.value),
                  })) as AppStateView,
                ),
              )
            }
          >
            {Array.from({ length: MAX_FIX_ROUNDS_SETTING + 1 }, (_, rounds) => (
              <option key={rounds} value={rounds}>
                {rounds}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      {projects.length ? (
        <section className="form-section" aria-labelledby="perm-effective">
          <h2 id="perm-effective">Effective permissions by project</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Source</th>
                <th scope="col">Effective</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>{project.name}</td>
                  <td>{project.policy.toolTrust ? "Project override" : "App default"}</td>
                  <td>
                    {toolTrustLabel(
                      effectiveToolTrust(project.policy.toolTrust, state.permissions),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Change a project's override from the permission chip next to Send or in Project
            settings.
          </p>
        </section>
      ) : null}
      <h2 className="group-title">Advanced</h2>
      <ReviewerSettings state={state} onState={onState} />
      <SavedRules state={state} onState={onState} />
    </>
  );
}

function ReviewerSettings({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const save = useSaveState();
  const models = state.probe?.interactiveModels ?? [];
  const settings = state.permissions;
  const qualified = settings.reviewer?.qualifiedProfileIds ?? [];
  const persist = (next: typeof settings) =>
    void save.save(async () => onState(await window.poundlockDispatch.savePermissions(next)));
  const selectedMissing =
    settings.reviewer?.profileId &&
    !models.some((m) => [m.id, m.profileId].includes(settings.reviewer!.profileId));
  return (
    <section className="form-section" aria-labelledby="perm-reviewer">
      <h2 id="perm-reviewer">Action approval reviewer</h2>
      <p className="hint">
        Used only in Approve for me. Reviews run in isolated contexts, approve one action and cannot
        save permissions. Only explicitly local inference is eligible. Reviewer failures return the
        decision to you. Saves immediately.
      </p>
      <div className="field">
        <label htmlFor="reviewer-model">Reviewer model</label>
        <select
          id="reviewer-model"
          value={settings.reviewer?.profileId ?? ""}
          disabled={save.saving}
          onChange={(event) =>
            persist({
              ...settings,
              reviewer: { ...settings.reviewer, profileId: event.target.value || undefined },
            })
          }
        >
          <option value="">Automatic — qualified models only</option>
          {selectedMissing ? (
            <option value={settings.reviewer!.profileId}>
              {settings.reviewer!.profileId} — unavailable, not in current discovery
            </option>
          ) : null}
          {models.map((m) => (
            <option key={m.id} value={m.profileId ?? m.id}>
              {m.name ?? m.id}
            </option>
          ))}
        </select>
        <p className="hint">
          Choosing a model permits trying it; it does not certify accuracy. Automatic selection uses
          only models marked qualified below.
        </p>
      </div>
      <details className="disclosure">
        <summary>Models qualified for automatic selection ({qualified.length})</summary>
        <p className="hint">Mark a model after its Toolkit approval-review evaluation passes.</p>
        {models.length ? (
          models.map((m) => {
            const id = m.profileId ?? m.id;
            return (
              <label className="checkbox-row" key={id}>
                <input
                  type="checkbox"
                  checked={qualified.includes(id)}
                  disabled={save.saving}
                  onChange={(event) =>
                    persist({
                      ...settings,
                      reviewer: {
                        ...settings.reviewer,
                        qualifiedProfileIds: event.target.checked
                          ? [...qualified, id]
                          : qualified.filter((item) => item !== id),
                      },
                    })
                  }
                />
                <span>{m.name ?? m.id}</span>
              </label>
            );
          })
        ) : (
          <p className="hint">
            No interactive profiles loaded. Refresh server info under Connection.
          </p>
        )}
      </details>
      <SaveStatus state={save.state} savedText="Reviewer setting saved" />
    </section>
  );
}

function SavedRules({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const settings = state.permissions;
  const [projectId, setProjectId] = useState(
    state.snapshot?.project.id ?? state.projects[0]?.id ?? "",
  );
  const [rules, setRules] = useState<SavedPermission[]>(settings.grants?.[projectId] ?? []);
  const [invalid, setInvalid] = useState<string>();
  const save = useSaveState();
  const dirty = JSON.stringify(rules) !== JSON.stringify(settings.grants?.[projectId] ?? []);
  function update(index: number, patch: Partial<SavedPermission>) {
    setRules(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
    setInvalid(undefined);
  }
  return (
    <section className="form-section" aria-labelledby="perm-rules">
      <h2 id="perm-rules">Saved exact-action permissions</h2>
      <p className="hint">
        Created when you choose a remember option on an approval. Each rule matches one exact action
        and working directory; command names are never blanket permissions.
      </p>
      {state.projects.length ? (
        <div className="field">
          <label htmlFor="rules-project">Project</label>
          <select
            id="rules-project"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setRules(settings.grants?.[event.target.value] ?? []);
              save.reset();
            }}
          >
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="hint">Add a project first.</p>
      )}
      {projectId && !rules.length ? (
        <p className="hint">No saved permissions for this project.</p>
      ) : null}
      {rules.map((rule, index) => (
        <fieldset className="rule" key={index}>
          <legend>Permission {index + 1}</legend>
          <div className="field">
            <label htmlFor={`rule-kind-${index}`}>Action type</label>
            <select
              id={`rule-kind-${index}`}
              value={rule.kind}
              onChange={(event) => update(index, { kind: event.target.value as "bash" | "write" })}
            >
              <option value="bash">Exact command</option>
              <option value="write">Edit one file</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`rule-action-${index}`}>
              {rule.kind === "bash" ? "Command" : "Full file path"}
            </label>
            <input
              id={`rule-action-${index}`}
              value={rule.action}
              aria-invalid={Boolean(invalid) && !rule.action.trim()}
              onChange={(event) => update(index, { action: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`rule-cwd-${index}`}>Working directory</label>
            <input
              id={`rule-cwd-${index}`}
              value={rule.cwd}
              aria-invalid={Boolean(invalid) && !rule.cwd.startsWith("/")}
              onChange={(event) => update(index, { cwd: event.target.value })}
            />
          </div>
          <button
            type="button"
            className="quiet small danger-text"
            onClick={() => setRules(rules.filter((_, i) => i !== index))}
          >
            Remove permission {index + 1}
          </button>
        </fieldset>
      ))}
      {invalid ? (
        <p className="field-error" role="alert">
          {invalid}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          disabled={!projectId}
          onClick={() => {
            const project = state.projects.find((p) => p.id === projectId);
            setRules([
              ...rules,
              {
                kind: "bash",
                action: "",
                cwd: project?.source.kind === "local_folder" ? project.source.originalPath : "",
              },
            ]);
          }}
        >
          Add exact action
        </button>
        <button
          type="button"
          className="primary"
          disabled={save.saving || !projectId || !dirty}
          onClick={() => {
            if (rules.some((r) => !r.action.trim() || !r.cwd.startsWith("/"))) {
              setInvalid("Enter an exact action and a full working directory for each permission.");
              return;
            }
            void save.save(async () =>
              onState(
                await window.poundlockDispatch.savePermissions({
                  ...settings,
                  grants: { ...settings.grants, [projectId]: rules },
                }),
              ),
            );
          }}
        >
          {save.saving ? "Saving…" : "Save permissions"}
        </button>
        <SaveStatus
          state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
        />
      </div>
    </section>
  );
}

function SettingsIntegrations({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <p className="page-intro">
        Optional Git service accounts for private repositories, pushing and pull requests. Stored
        only on this computer, never sent to Poundlock. Not required to add a project.
      </p>
      <ForgeForm kind="github" state={state} onState={onState} />
      <ForgeForm kind="gitea" state={state} onState={onState} />
    </>
  );
}

function ForgeForm({
  kind,
  state,
  onState,
}: {
  kind: "github" | "gitea";
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const account = state.integrations[kind];
  const title = kind === "github" ? "GitHub" : "Gitea";
  const [host, setHost] = useState(
    account?.host || (kind === "github" ? "https://github.com" : ""),
  );
  const [user, setUser] = useState(account?.username || "");
  const [token, setToken] = useState("");
  const save = useSaveState();
  const dirty =
    host !== (account?.host || (kind === "github" ? "https://github.com" : "")) ||
    user !== (account?.username || "") ||
    Boolean(token);
  const persist = (work: () => Promise<unknown>) =>
    void save.save(async () => {
      const next = await work();
      if (next && typeof next === "object" && "projects" in next) onState(next as AppStateView);
      setToken("");
    });
  return (
    <form
      className="form-section"
      aria-labelledby={`${kind}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        persist(() =>
          kind === "github"
            ? window.poundlockDispatch.saveGithub({ host, username: user, token })
            : window.poundlockDispatch.saveGitea({ host, username: user, token }),
        );
      }}
    >
      <div className="section-head">
        <h2 id={`${kind}-title`}>{title}</h2>
        <span className={`state-pill ${account?.configured ? "accepted" : "muted"}`}>
          {account?.configured ? "Configured" : "Not configured"}
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${kind}-host`}>{kind === "github" ? "Host" : "Base URL"}</label>
        <input
          id={`${kind}-host`}
          value={host}
          placeholder={kind === "gitea" ? "https://gitea.example.net" : undefined}
          onChange={(event) => setHost(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${kind}-user`}>Username</label>
        <input id={`${kind}-user`} value={user} onChange={(event) => setUser(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${kind}-token`}>
          {kind === "github" ? "Personal access token" : "Access token"}
        </label>
        <input
          id={`${kind}-token`}
          type="password"
          autoComplete="off"
          value={token}
          placeholder={account?.configured ? "Saved — paste to replace" : "Paste token"}
          aria-describedby={`${kind}-token-help`}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="hint" id={`${kind}-token-help`}>
          {kind === "github"
            ? "Needs contents read/write and pull requests. Dispatch will not push until you confirm."
            : "Self-hosted Gitea needs the base URL. Attach it to a project the same way as GitHub."}
        </p>
      </div>
      <div className="form-actions">
        <button type="submit" className="primary" disabled={save.saving || !dirty}>
          {save.saving ? "Saving…" : `Save ${title}`}
        </button>
        {account ? (
          <button
            type="button"
            className="quiet danger-text"
            disabled={save.saving}
            onClick={() => persist(() => window.poundlockDispatch.removeForge(kind))}
          >
            Remove account
          </button>
        ) : null}
        <SaveStatus
          state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
        />
      </div>
    </form>
  );
}

function ConnectionFields({
  url,
  address,
  token,
  tokenConfigured,
  onAddress,
  onToken,
}: {
  url: string;
  address: string;
  token: string;
  tokenConfigured?: boolean;
  onAddress: (value: string) => void;
  onToken: (value: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="url">Controller address</label>
        <input
          id="url"
          value={address}
          placeholder={EXAMPLE_CONTROLLER_URL}
          aria-describedby="url-help"
          onChange={(event) => onAddress(event.target.value)}
        />
        <p className="hint" id="url-help">
          {address && address === url
            ? "Saved address."
            : `For example ${EXAMPLE_CONTROLLER_URL}. A remote HTTPS controller also works.`}
        </p>
      </div>
      <div className="field">
        <label htmlFor="token">Application token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={token}
          aria-describedby="token-help"
          placeholder={tokenConfigured ? "Saved — leave blank to keep it" : "Paste token"}
          onChange={(event) => onToken(event.target.value)}
        />
        <p className="hint" id="token-help">
          Stored only on this computer. Never shown again, and never included in prompts or worker
          jobs.
        </p>
      </div>
    </>
  );
}

/**
 * One role's model picker plus the per-profile preferences (destination override, Thinking) that
 * belong to whichever profile is selected. Fully expanded, no disclosure — used both by the setup
 * wizard and by each Models and routing panel in Settings.
 */
/** Per-profile preferences (destination override, Thinking), shared by every role field on a
 * page so mounting several at once (the setup wizard) costs one copy, not one per field. */
type ProfilePreferences = NonNullable<AppStateView["connection"]["profiles"]>;

function RoleModelField({
  roleId,
  roles,
  catalog,
  probe,
  onChange,
  preferences,
  onPreferencesChange,
}: {
  roleId: "manager" | "interactive" | "snippet" | "verifier";
  roles: RoleMap;
  catalog: CatalogProfile[];
  probe?: AppStateView["probe"];
  onChange: (roles: RoleMap) => void;
  preferences: ProfilePreferences;
  onPreferencesChange: (preferences: ProfilePreferences) => void;
}) {
  const [preferenceError, setPreferenceError] = useState("");
  const [preferenceSaved, setPreferenceSaved] = useState(false);
  async function savePreference(profile: CatalogProfile, update: ProfilePreference) {
    const id = profile.profileId ?? profile.id;
    try {
      const value = await window.poundlockDispatch.saveProfile(id, {
        ...preferences[id],
        ...update,
      });
      onPreferencesChange(value.connection.profiles ?? {});
      setPreferenceError("");
      setPreferenceSaved(true);
    } catch (error) {
      setPreferenceError(String(error));
      setPreferenceSaved(false);
    }
  }
  const role = ROLE_DEFINITIONS.find((item) => item.id === roleId)!;
  const current = roles[roleId];
  const selected = current ? catalogMatchesBinding(catalog, current) : undefined;
  const preference = selected ? preferences[selected.profileId ?? selected.id] : undefined;
  const destination = effectiveDestination(
    selected?.dataDestination,
    preference?.approvedDestination,
  ) as typeof selected extends undefined ? undefined : DataDestination;
  const externalPermissionMissing =
    destination === "external" && Boolean(probe) && !probe!.permissions.includes("external:invoke");
  return (
    <div className="field role-row">
      {externalPermissionMissing ? (
        <div className="notice error" role="alert">
          This application token cannot use the selected external profile. In Poundlock Access,
          create a replacement token with Call external providers, save it under Connection, then
          test again.
        </div>
      ) : null}
      <label htmlFor={`role-${roleId}`}>
        {role.label}
        {role.required ? "" : " (optional)"}
      </label>
      <ModelPicker
        id={`role-${roleId}`}
        value={current?.profileId ?? ""}
        savedName={current?.profileName}
        role={roleId}
        catalog={catalog}
        emptyLabel={role.required ? "Choose a model" : "Not configured"}
        onChange={(value) => {
          const copy = { ...roles };
          const profile = catalog.find((p) => (p.profileId ?? p.id) === value);
          if (profile) copy[roleId] = bindingForProfile(profile);
          else delete copy[roleId];
          onChange(copy);
        }}
      />
      <p className="hint">{role.hint}</p>
      {selected ? (
        <>
          <p className="hint">
            Destination: {destinationLabel(destination)}
            {preference?.approvedDestination ? " (your override)" : " (reported by Poundlock)"}
          </p>
          {roleId === "manager" && destination === "external" ? (
            <p className="hint">
              Saving this default authorizes this exact profile route to receive selected project
              context. Poundlock also requires the token permission Call external providers.
            </p>
          ) : null}
          <div className="subsection">
            <p className="hint">
              Profile: {profileDisplayName(selected)}. Transport:{" "}
              {endpointKindLabel(selected.endpointKind)}. These two settings belong to the profile,
              not this role — changing them here also changes them for every other role that uses{" "}
              {selected.name}.
            </p>
            <div className="field">
              <label htmlFor={`dest-${roleId}`}>Reported destination override</label>
              <select
                id={`dest-${roleId}`}
                value={preference?.approvedDestination ?? ""}
                onChange={(event) =>
                  void savePreference(selected, {
                    approvedDestination: (event.target.value || undefined) as
                      | DataDestination
                      | undefined,
                  })
                }
              >
                <option value="">Use Poundlock’s reported destination</option>
                <option value="operator_network">My own infrastructure</option>
                <option value="external">External provider (external policy applies)</option>
              </select>
              <p className="hint">
                Only corrects missing or wrong server metadata. Changes approval handling, not
                routing.
              </p>
            </div>
            <div className="field">
              <span className="label">Thinking</span>
              <p className="hint">
                {selected.thinking === "off"
                  ? "Off. Poundlock turns thinking off for this profile, for every client."
                  : "The model's own default. Poundlock sets no thinking preference for this profile."}{" "}
                Change it on the profile in Poundlock; off is faster and more reliable for small
                local reasoning models on focused edits.
              </p>
            </div>
            {roleId === "manager" || roleId === "interactive" || roleId === "verifier" ? (
              <RoleReasoningField
                roleId={roleId}
                roles={roles}
                profile={selected}
                onChange={onChange}
              />
            ) : null}
            {selected.servedModel || selected.pricing ? (
              <p className="hint">
                {selected.servedModel ? `Served by ${selected.servedModel}. ` : ""}
                {selected.pricing
                  ? `About $${selected.pricing.inputPerMtok.toFixed(2)} in / $${selected.pricing.outputPerMtok.toFixed(2)} out per million tokens (${pricingSourceLabel(selected.pricing.source)}; an estimate, not a bill).`
                  : ""}
              </p>
            ) : null}
            {selected.status === "disabled" ? (
              <p className="notice error" role="alert">
                Poundlock took this profile out of service: {selected.disabled?.reason}. An operator
                can retest or re-enable it in Poundlock.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
      {preferenceError ? (
        <p className="notice error" role="alert">
          {preferenceError}
        </p>
      ) : preferenceSaved ? (
        <p className="save-status saved" role="status">
          Model setting saved
        </p>
      ) : null}
    </div>
  );
}

function pricingSourceLabel(source: string): string {
  return (
    {
      litellm_route: "gateway route price",
      litellm_cost_map: "gateway cost map",
      openrouter_catalog: "OpenRouter catalog",
      local: "local",
      operator: "set by the operator",
    }[source] ?? source
  );
}

/** A role's reasoning default for its profile. Offers only what Poundlock verified. */
function RoleReasoningField({
  roleId,
  roles,
  profile,
  onChange,
}: {
  roleId: "manager" | "interactive" | "verifier";
  roles: RoleMap;
  profile: CatalogProfile;
  onChange: (roles: RoleMap) => void;
}) {
  const binding = roles[roleId];
  const offered = offeredReasoning(profile);
  const externalNone =
    roleId === "manager" &&
    profile.dataDestination === "external" &&
    (profile.reasoningLevels ?? []).includes("none");
  const saved = binding?.reasoning;
  const unsupported = saved && !offered.includes(saved);
  return (
    <div className="field">
      <label htmlFor={`reasoning-${roleId}`}>Reasoning</label>
      <select
        id={`reasoning-${roleId}`}
        value={saved ?? ""}
        onChange={(event) => {
          if (!binding) return;
          const value = event.target.value as ReasoningChoice | "";
          const next = { ...binding };
          if (value) next.reasoning = value;
          else delete next.reasoning;
          onChange({ ...roles, [roleId]: next });
        }}
      >
        <option value="">
          {externalNone
            ? "Default (None, because this manager is external)"
            : "Default (Model default)"}
        </option>
        {offered.map((choice) => (
          <option key={choice} value={choice}>
            {reasoningLabel(choice)}
          </option>
        ))}
        {unsupported ? <option value={saved}>{reasoningLabel(saved)} (not verified)</option> : null}
      </select>
      <p className="hint">
        {offered.length > 1
          ? `Poundlock verified ${(profile.reasoningLevels ?? []).map(reasoningLabel).join(", ").toLowerCase()} on this model. Model default sends nothing. A conversation can override this from the composer.`
          : "Poundlock has verified no explicit reasoning levels for this model, so it runs at its own default."}
      </p>
      {unsupported ? (
        <p className="notice error" role="alert">
          {reasoningLabel(saved)} is no longer verified for {profile.name}. Choose another; Dispatch
          will not substitute one.
        </p>
      ) : null}
    </div>
  );
}

/** Setup-wizard view: all four roles fully expanded on one page, no expand/collapse. */
function RoleMapFields({
  catalog,
  probe,
  roles,
  onChange,
  preferences,
  onPreferencesChange,
}: {
  catalog: CatalogProfile[];
  probe?: AppStateView["probe"];
  roles: RoleMap;
  onChange: (roles: RoleMap) => void;
  preferences: ProfilePreferences;
  onPreferencesChange: (preferences: ProfilePreferences) => void;
}) {
  const roleIds: Array<"manager" | "interactive" | "snippet"> = [
    "manager",
    "interactive",
    "snippet",
  ];
  return (
    <div>
      {roleIds.map((roleId) => (
        <RoleModelField
          key={roleId}
          roleId={roleId}
          roles={roles}
          catalog={catalog}
          probe={probe}
          onChange={onChange}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
        />
      ))}
    </div>
  );
}
