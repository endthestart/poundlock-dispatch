import {
  type CatalogProfile,
  catalogMatchesBinding,
  type ExecutionRole,
  profileDisplayName,
  profileRouteLabel,
  roleUnavailableReason,
  UNAVAILABLE_SELECTION_MESSAGE,
  unavailableSelectionLabel,
} from "@shared/roles";

/** Shared picker keeps project overrides, app defaults and the model ladder consistent. */
export function ModelPicker({
  id,
  value,
  savedName,
  onChange,
  catalog,
  role,
  emptyLabel = "Choose a model",
  emptyOption = true,
  disabled = false,
  extraDisabled,
  describeRoute = profileRouteLabel,
  ariaLabel,
}: {
  id: string;
  value: string;
  /** Display name saved alongside `value`, used if Poundlock no longer advertises this profile. */
  savedName?: string;
  onChange: (id: string) => void;
  catalog: CatalogProfile[];
  role: ExecutionRole;
  emptyLabel?: string;
  /** Set false to omit the blank placeholder option, for a field that always holds a choice. */
  emptyOption?: boolean;
  disabled?: boolean;
  /** An extra reason a profile can't be picked here, beyond role eligibility (e.g. already used). */
  extraDisabled?: (profile: CatalogProfile) => string | undefined;
  /** Route description per option; defaults to the destination/transport line. Override to add
   * detail such as context-token count or a caller-approved destination override. */
  describeRoute?: (profile: CatalogProfile) => string;
  /** For a field with no visible `<label>`, e.g. one row of several identical pickers. */
  ariaLabel?: string;
}) {
  const selected = value
    ? catalogMatchesBinding(catalog, {
        profileId: value,
        profileName: value,
        source: "interactive",
      })
    : undefined;
  const unavailableReason = (profile: CatalogProfile) => roleUnavailableReason(profile, role);
  return (
    <>
      <select
        id={id}
        aria-label={ariaLabel}
        value={selected ? (selected.profileId ?? selected.id) : value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {emptyOption ? <option value="">{emptyLabel}</option> : null}
        {value && !selected ? (
          <option value={value}>
            {unavailableSelectionLabel({ profileId: value, profileName: savedName })} — saved
            selection, not advertised
          </option>
        ) : null}
        {catalog.map((profile) => {
          const reason = unavailableReason(profile) ?? extraDisabled?.(profile);
          const key = profile.profileId ?? profile.id;
          return (
            <option key={key} value={key} disabled={Boolean(reason)}>
              {profileDisplayName(profile)} · {describeRoute(profile)}
              {reason ? ` — ${reason}` : ""}
            </option>
          );
        })}
      </select>
      {value && !selected && catalog.length ? (
        <p className="field-error">{UNAVAILABLE_SELECTION_MESSAGE}</p>
      ) : null}
      {selected && unavailableReason(selected) ? (
        <p className="hint">
          This saved choice is unavailable: {unavailableReason(selected)}. Choose an eligible model.
        </p>
      ) : null}
    </>
  );
}
