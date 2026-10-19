import { type EscalationSettings, escalationSettings } from "@shared/escalation";
import {
  bindingForProfile,
  type CatalogProfile,
  catalogFromProbe,
  catalogMatchesBinding,
  hasUse,
  profileDisplayName,
  profileRouteLabel,
} from "@shared/roles";
import { formatMoney } from "@shared/status-infolets";
import type { AppStateView } from "@shared/types";
import { useMemo, useState } from "react";
import { SaveStatus, useSaveState } from "./dialog";
import { ModelPicker } from "./model-picker";

export function SettingsEscalation({
  state,
  onState,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
}) {
  const [draft, setDraft] = useState<EscalationSettings>(() =>
    escalationSettings(state.connection.escalation, state.connection.roles),
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const save = useSaveState();
  const catalog = useMemo(() => (state.probe ? catalogFromProbe(state.probe) : []), [state.probe]);
  const options = catalog.filter((item) => !hasUse(item, "completion"));
  const gatewayProfiles = options.filter((item) => item.endpointKind === "litellm");
  const externalProfiles = options.filter(
    (item) =>
      (state.connection.profiles?.[item.profileId ?? item.id]?.approvedDestination ??
        item.dataDestination) === "external",
  );
  const baseWorker = state.connection.roles.interactive;
  const baseWorkerProfile = baseWorker ? catalogMatchesBinding(options, baseWorker) : undefined;
  function rungRoute(item: (typeof options)[number]) {
    const destination =
      state.connection.profiles?.[item.profileId ?? item.id]?.approvedDestination ??
      item.dataDestination;
    const context = item.context_tokens
      ? `${item.context_tokens.toLocaleString()} tokens context`
      : "context limit not reported";
    return `${profileRouteLabel({ ...item, dataDestination: destination })} · ${context}`;
  }
  function update(value: EscalationSettings) {
    setDraft(value);
    setDirty(true);
  }
  function move(index: number, direction: number) {
    const profiles = [...draft.profiles];
    [profiles[index], profiles[index + direction]] = [profiles[index + direction], profiles[index]];
    update({ ...draft, profiles });
  }
  async function perform(label: string, work: () => Promise<AppStateView>) {
    setBusy(label);
    setError("");
    try {
      onState(await work());
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <h1 className="page-title">Model ladder</h1>
      <p className="page-intro">
        Ordered, stronger models Dispatch may move a task to when the base worker's context or
        reliability isn't enough — local machines first, external providers only with your consent.
        Most projects never need more than the base worker.
      </p>
      <section className="form-section" aria-label="Model ladder configuration">
        <p className="hint">
          The base worker is rung 0. Small tasks always start there; Dispatch may start a medium or
          large task on a further rung when the base worker's context is not enough. Beyond that,
          the Project Manager coordinates climbing the ladder for its own reasoning and for worker
          repairs, records the evidence, and uses your order below. Workers cannot independently
          choose a further model.
        </p>
        <div className="subsection">
          <h3>Base worker (rung 0)</h3>
          {baseWorker ? (
            <p>
              <strong>
                {baseWorkerProfile ? profileDisplayName(baseWorkerProfile) : baseWorker.profileName}
              </strong>{" "}
              · {baseWorkerProfile ? rungRoute(baseWorkerProfile) : "not currently advertised"}
            </p>
          ) : (
            <p className="notice">
              No interactive worker is mapped. Choose one in Settings → Models.
            </p>
          )}
        </div>
        <div className="subsection">
          <h3>Further rungs</h3>
          <p className="hint">
            Choose published Poundlock profiles in the order you want them tried after the base
            worker. This list is your capability preference. An unavailable next profile is
            reported, never silently skipped.
          </p>
          <div className="notice">
            Poundlock currently publishes {gatewayProfiles.length} selectable profile
            {gatewayProfiles.length === 1 ? "" : "s"} routed through LiteLLM;{" "}
            {externalProfiles.length} send data to external providers. Dispatch lists saved
            Poundlock profiles; routes that exist only inside LiteLLM must first be published in
            Poundlock, under Models.
          </div>
          {draft.profiles.map((binding, index) => {
            return (
              <div key={`${index}:${binding.profileId}`}>
                <div className="escalation-row">
                  <span>Rung {index + 1}.</span>
                  <ModelPicker
                    id={`escalation-model-${index}`}
                    ariaLabel={`Escalation model ${index + 1}`}
                    value={binding.profileId}
                    savedName={binding.profileName}
                    role="escalation"
                    catalog={options}
                    emptyOption={false}
                    disabled={Boolean(busy)}
                    describeRoute={rungRoute}
                    extraDisabled={(item: CatalogProfile) =>
                      draft.profiles.some(
                        (other, at) =>
                          at !== index && Boolean(catalogMatchesBinding([item], other)),
                      )
                        ? "Already used in another rung"
                        : undefined
                    }
                    onChange={(next) => {
                      const profile = options.find((item) => (item.profileId ?? item.id) === next);
                      if (profile)
                        update({
                          ...draft,
                          profiles: draft.profiles.map((item, at) =>
                            at === index ? bindingForProfile(profile) : item,
                          ),
                        });
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Move ${binding.profileName} up`}
                    disabled={Boolean(busy) || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${binding.profileName} down`}
                    disabled={Boolean(busy) || index === draft.profiles.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      update({ ...draft, profiles: draft.profiles.filter((_, at) => at !== index) })
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
          {!draft.profiles.length ? <p>No escalation models configured.</p> : null}
          <div className="toolbar">
            <button
              type="button"
              disabled={
                Boolean(busy) ||
                !options.some(
                  (item) =>
                    !draft.profiles.some((other) => Boolean(catalogMatchesBinding([item], other))),
                )
              }
              onClick={() => {
                const profile = options.find(
                  (item) =>
                    !draft.profiles.some((other) => Boolean(catalogMatchesBinding([item], other))),
                );
                if (profile)
                  update({
                    ...draft,
                    profiles: [...draft.profiles, bindingForProfile(profile)],
                  });
              }}
            >
              Add model
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void perform("Refreshing", () => window.poundlockDispatch.refreshServerInfo())
              }
            >
              {busy === "Refreshing" ? "Refreshing…" : "Refresh available profiles"}
            </button>
          </div>
          {!options.length ? (
            <p className="hint">
              Refresh discovery. Profiles must be published in Poundlock before Dispatch can select
              them; an upstream LiteLLM model list alone does not publish them.
            </p>
          ) : null}
        </div>
        <div className="subsection">
          <h3>Authorization</h3>
          <label htmlFor="escalation-mode">When the manager requests a further rung</label>
          <select
            id="escalation-mode"
            value={draft.mode}
            disabled={Boolean(busy)}
            onChange={(event) =>
              update({ ...draft, mode: event.target.value as EscalationSettings["mode"] })
            }
          >
            <option value="ask">Ask for each move up the ladder</option>
            <option value="standing">Standing authorization for this list</option>
          </select>
          <p className="hint">
            Standing authorization applies to all projects on this connection. It permits selected
            project context and worker results to reach the listed rungs, including declared
            external providers. Unknown destinations still require a decision. It does not grant
            access to secrets, authorize source snapshots, or expand tool permissions.
          </p>
          <label htmlFor="escalation-limit">
            Maximum escalation transitions to an external provider, per run
          </label>
          <input
            id="escalation-limit"
            type="number"
            min={1}
            max={20}
            value={draft.maxTransitionsPerRun}
            disabled={Boolean(busy)}
            onChange={(event) =>
              update({ ...draft, maxTransitionsPerRun: Number(event.target.value) })
            }
          />
          <p className="hint">
            Shared by manager and workers, and counted for the whole run — approving a revised plan
            does not refresh it. Moving to a rung on your own infrastructure never uses this limit;
            it is bounded only by how many such rungs are in the ladder above, per task. Existing
            manager-turn, worker-attempt and repair limits also apply.
          </p>
          <ManagedUsage rows={state.probe?.managedIdentities ?? []} />
        </div>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          <button
            type="button"
            className="primary"
            disabled={Boolean(busy) || save.saving || !dirty}
            onClick={() =>
              void save.save(async () => {
                onState(await window.poundlockDispatch.saveEscalation(draft));
                setDirty(false);
              })
            }
          >
            {save.saving ? "Saving…" : "Save escalation settings"}
          </button>
          <SaveStatus
            state={dirty && save.state.kind !== "saving" ? { kind: "dirty" } : save.state}
            savedText="Saved; active work was paused, resume when ready"
          />
        </div>
      </section>
    </>
  );
}

function ManagedUsage({
  rows,
}: {
  rows: NonNullable<AppStateView["probe"]>["managedIdentities"] extends infer T
    ? NonNullable<T>
    : never;
}) {
  if (!rows.length) {
    return (
      <div className="notice">
        No application-scoped gateway usage is available. Provider limits remain configured and
        enforced in LiteLLM.
      </div>
    );
  }
  return (
    <div className="notice">
      <strong>Application gateway usage</strong>
      {rows.map((row) => {
        const spend = row.usage?.spend;
        const maximum = row.usage?.max_budget ?? row.budget?.max_budget;
        const remaining = row.usage?.remaining_budget;
        const reset = row.usage?.budget_reset_at;
        const observed = row.usage?.observed_at;
        return (
          <p key={row.endpoint_id} className="hint">
            {row.usage_status === "available"
              ? [
                  typeof spend === "number" ? `${formatMoney(spend)} used` : undefined,
                  typeof maximum === "number" ? `${formatMoney(maximum)} limit` : undefined,
                  typeof remaining === "number" ? `${formatMoney(remaining)} remaining` : undefined,
                  reset ? `resets ${new Date(reset).toLocaleString()}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : `Usage ${row.usage_status ?? "unavailable"}`}
            {row.external_authorized === false
              ? " · current token cannot call external profiles"
              : ""}
            {observed ? ` · updated ${new Date(observed).toLocaleString()}` : ""}
          </p>
        );
      })}
      <p className="hint">
        Poundlock reports only this application identity. LiteLLM remains authoritative for
        accounting and enforcement.
      </p>
    </div>
  );
}
