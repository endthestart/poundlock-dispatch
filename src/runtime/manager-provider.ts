import type { ApprovalBroker } from "@core/approval-broker";
import { escalationPolicyKey, validEscalationGrant } from "@core/escalation";
import { sha256Text } from "@core/ids";
import { normalizeLocalManager } from "@core/local-manager";
import type { ManagerPort } from "@core/orchestration";
import { PoundlockClient } from "@core/poundlock";
import { FileStore } from "@core/store";
import { inferenceApprovalText } from "@shared/inference-approval";
import { resolveReasoning } from "@shared/reasoning";
import {
  approvedRoutingRevision,
  approvedRoutingRevisionForProfile,
  effectiveDestination,
  interactiveUnavailableReason,
  managerChoice,
  profileDisplayName,
  savedRoleAuthorizesDestination,
  selectedManagerAuthorizesDestination,
} from "@shared/roles";
import { createOfflineManager } from "./offline-manager";
import { createPiManager } from "./pi-manager";

export function createManagerProvider(
  getStore: () => FileStore,
  approvals: ApprovalBroker,
  onActivity: (text: string, projectId?: string) => Promise<void> | void,
  onSelection?: (selection: import("@shared/types").AppStateView["managerSelection"]) => void,
  getCapabilities?: () => import("@core/capabilities").PoundlockCapabilities | undefined,
) {
  let manager: ManagerPort | undefined;
  let managerKey = "";
  async function get(
    project: import("@shared/types").ProjectRecord,
    signal?: AbortSignal,
  ): Promise<ManagerPort> {
    if (process.env.POUNDLOCK_DISPATCH_FAKE_MANAGER === "1") {
      if (!manager) manager = createOfflineManager(getStore());
      return manager;
    }
    const store = getStore();
    const connection = await store.getConnection();

    const grant = project.managerEscalation;
    if (grant && !validEscalationGrant(grant, connection, project))
      throw new Error(
        "Manager escalation authorization changed. Review frontier settings before continuing.",
      );
    if (!grant && connection.localManager?.enabled) {
      const local = normalizeLocalManager(connection.localManager);
      onSelection?.({
        projectId: project.id,
        name: `${local.model} · this computer`,
        origin: "local",
      });
      const key = sha256Text(
        JSON.stringify([
          "local",
          local.url,
          local.model,
          local.token,
          local.contextTokens,
          local.maxOutputTokens,
          connection.webSearch?.url,
        ]),
      );
      if (manager && managerKey === key) return manager;
      await onActivity(`Loading the Project Manager (${local.model})…`, project.id);
      manager = await createPiManager({
        store,
        webSearch: connection.webSearch,
        controllerUrl: local.url,
        token: local.token || "local-model",
        modelName: local.model,
        modelLabel: `${local.model} · this computer`,
        contextTokens: local.contextTokens,
        maxOutputTokens: local.maxOutputTokens,
        lastApprovedRoutingRevision: approvedRoutingRevision(connection.roles.manager),
        providerId: "local-manager",
        capabilities: getCapabilities?.(),
      });
      managerKey = key;
      return manager;
    }
    const choice = managerChoice(project, connection.roles);
    const modelName = choice.id;
    const models = await new PoundlockClient(
      connection.url,
      connection.token,
    ).listInteractiveModels();
    const profile = models.find((item) =>
      [item.id, item.profileId, ...(item.aliases ?? [])].includes(modelName),
    );
    if (!profile)
      throw new Error(
        "The selected manager profile is no longer advertised. Update Settings → Models or the project override.",
      );
    if (grant?.routingRevision && grant.routingRevision !== profile.routingRevision)
      throw new Error(
        "The authorized manager route changed in Poundlock. Review its destination and escalation settings before continuing.",
      );
    const unavailable = interactiveUnavailableReason(profile);
    if (unavailable)
      throw new Error(
        `The selected manager cannot run this conversation: ${unavailable}. Choose a model in Settings → Models or Project settings.`,
      );
    // Checked before any approval prompt or request, so an unsupported saved
    // choice is reported instead of sent, and never swapped for another.
    const { choice: reasoning } = resolveReasoning({
      model: profile,
      role: "manager",
      roleDefault: choice.origin === "default" ? connection.roles.manager?.reasoning : undefined,
      conversation: project.reasoningOverride,
    });
    onSelection?.({
      projectId: project.id,
      name: profileDisplayName({
        name: profile.name ?? profile.id,
        modelLabel: profile.modelLabel,
        upstreamModel: profile.upstreamModel,
      }),
      origin: choice.origin,
    });
    const preference =
      connection.profiles?.[profile.profileId ?? profile.id] ??
      connection.profiles?.[profile.id] ??
      {};
    const destination = effectiveDestination(
      profile.dataDestination,
      preference.approvedDestination,
    );
    const standingRoute =
      destination === "operator_network" ||
      selectedManagerAuthorizesDestination(choice.id, profile, destination) ||
      savedRoleAuthorizesDestination(connection.roles, profile, destination) ||
      Boolean(grant && grant.destination === destination);
    if (!standingRoute) {
      const allowed = await approvals.request(
        {
          projectId: project.id,
          projectName: project.name,
          planRevision: project.planRevision,
          kind: "inference",
          ...inferenceApprovalText(profile.id, destination),
        },
        signal,
      );
      if (!allowed) throw new Error("Inference destination was not approved.");
    }
    if (
      signal?.aborted ||
      escalationPolicyKey(await store.getConnection()) !== escalationPolicyKey(connection)
    )
      throw new Error("Manager authorization changed before inference started.");
    const key = sha256Text(
      JSON.stringify([
        connection.url,
        profile.profileId ?? profile.id,
        profile.id,
        profile.routingRevision,
        connection.token,
        profile.context_tokens,
        profile.max_output_tokens,
        profile.reasoningLevels,
        connection.webSearch?.url,
      ]),
    );
    const withReasoning = (port: ManagerPort): ManagerPort => ({
      ...port,
      runTurn: (ctx) => port.runTurn({ ...ctx, reasoning }),
      // The summary is an inference request like any other, so it carries the
      // conversation's reasoning too.
      ...(port.compact ? { compact: (ctx) => port.compact!({ ...ctx, reasoning }) } : {}),
    });
    if (manager && managerKey === key) return withReasoning(manager);
    if (!connection.url || !connection.token) {
      manager = createOfflineManager(store);
      managerKey = "offline";
      return manager;
    }
    await onActivity(`Loading the Project Manager (${modelName})…`, project.id);
    manager = await createPiManager({
      store,
      webSearch: connection.webSearch,
      controllerUrl: connection.url,
      token: connection.token,
      modelName: profile.id,
      modelProfileId: profile.profileId ?? profile.id,
      modelLabel: profileDisplayName({
        name: profile.name ?? profile.id,
        modelLabel: profile.modelLabel,
        upstreamModel: profile.upstreamModel,
      }),
      contextTokens: profile.context_tokens,
      maxOutputTokens: profile.max_output_tokens,
      routingRevision: profile.routingRevision,
      dataDestination: profile.dataDestination,
      reasoningLevels: profile.reasoningLevels,
      lastApprovedRoutingRevision:
        grant?.routingRevision ?? approvedRoutingRevisionForProfile(connection.roles, profile),
      capabilities: getCapabilities?.(),
    });
    managerKey = key;
    return withReasoning(manager);
  }

  return {
    get,
    reset: async (id: string) => {
      await manager?.reset?.(id);
    },
    abort: (id: string) => manager?.abort?.(id),
    clear: () => {
      onSelection?.(undefined);
      manager = undefined;
      managerKey = "";
    },
  };
}
