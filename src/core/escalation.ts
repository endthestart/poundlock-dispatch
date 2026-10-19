import { type EscalationGrant, escalationSettings } from "@shared/escalation";
import type { ConnectionSettings, ProjectRecord } from "@shared/types";
import { sha256Text } from "./ids";

export function escalationPolicyKey(connection: ConnectionSettings): string {
  return sha256Text(
    JSON.stringify([
      connection.url.replace(/\/+$/, ""),
      connection.token,
      escalationSettings(connection.escalation, connection.roles),
      connection.profiles,
      connection.localManager,
    ]),
  );
}
export function validEscalationGrant(
  grant: EscalationGrant | undefined,
  connection: ConnectionSettings,
  project: ProjectRecord,
): grant is EscalationGrant {
  return Boolean(
    grant &&
      grant.planRevision === project.planRevision &&
      grant.policyKey === escalationPolicyKey(connection) &&
      escalationSettings(connection.escalation, connection.roles).profiles.some(
        (profile) => profile.profileId === grant.profile.profileId,
      ),
  );
}
/**
 * External-provider escalation transitions spent this run — the only kind
 * `maxTransitionsPerRun` bounds. A rung on the operator's own infrastructure
 * (`operator_network`) never counts here; it is bounded only by the ladder
 * itself (see `nextEscalation`), per task. Counted across the whole run:
 * `project.escalations` is cleared only when a run is archived (Start a new
 * run / New conversation), not when a revised plan is approved, so approving
 * a revision never refreshes this allowance.
 */
export function externalEscalationsUsed(project: Pick<ProjectRecord, "escalations">): number {
  return (project.escalations ?? []).filter((item) => item.destination !== "operator_network")
    .length;
}
export const OPERATIONAL_FAILURE =
  /capacity_in_use|infrastructure_unavailable|managed_identity_unavailable|upstream_timeout|timed? out|timeout|approval denied|permission denied|cancelled|interrupted|ECONN|network error|node.*offline|model.*load.*fail/i;
