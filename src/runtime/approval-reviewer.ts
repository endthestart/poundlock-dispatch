import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseReviewDecision,
  REVIEW_SYSTEM,
  type ReviewDecision,
  type ReviewRequest,
} from "@core/permission-review";
import { PoundlockClient } from "@core/poundlock";
import type { FileStore } from "@core/store";
import { effectiveDestination, sameRuntimeSlot } from "@shared/roles";

export function createApprovalReviewer(store: FileStore) {
  return async (request: ReviewRequest, signal: AbortSignal): Promise<ReviewDecision> => {
    try {
      const settings = await store.getPermissions();
      const connection = await store.getConnection();
      const configured = settings.reviewer?.profileId;
      const qualified = settings.reviewer?.qualifiedProfileIds ?? [];
      if (!configured && !qualified.length)
        return {
          decision: "ask_user",
          reason:
            "No approval reviewer has been selected or qualified for automatic selection yet.",
        };
      const models = await new PoundlockClient(
        connection.url,
        connection.token,
      ).listInteractiveModels();
      const eligible = models.filter((m) => {
        const id = m.profileId ?? m.id;
        const destination = effectiveDestination(
          m.dataDestination,
          connection.profiles?.[id]?.approvedDestination,
        );
        return (
          destination === "operator_network" &&
          (m.context_tokens ?? 0) >= 4096 &&
          (m.max_output_tokens ?? 0) >= 256 &&
          (configured ? [id, m.id].includes(configured) : qualified.includes(id))
        );
      });
      // The worker asking for this approval is paused on it, holding a model
      // loaded on its machine. A reviewer that is a different profile on that
      // same single slot would unload the worker's model to answer, and with a
      // 15-second budget it would usually time out mid-load anyway — leaving
      // the worker to reload afterwards. Ask the user instead.
      const running = (await store.getTasks(request.authority.projectId))
        .flatMap((task) => task.attempts)
        .find((attempt) => attempt.status === "running" && attempt.execution === "interactive");
      const worker = running?.profileId
        ? models.find((m) => [m.profileId, m.id].includes(running.profileId))
        : undefined;
      const evictsWorker = (m: (typeof models)[number]) =>
        Boolean(worker) &&
        (m.profileId ?? m.id) !== (worker!.profileId ?? worker!.id) &&
        sameRuntimeSlot(m, worker);
      const model = eligible.find((m) => !m.busy && !evictsWorker(m));
      if (!model)
        return {
          decision: "ask_user",
          reason: eligible.some(evictsWorker)
            ? "The approval reviewer runs on the same machine as this worker and would unload the worker's model to answer, so this decision is yours."
            : "The configured local approval reviewer is unavailable; no worker or frontier model was substituted.",
        };
      if (
        JSON.stringify(request).length + REVIEW_SYSTEM.length >
        ((model.context_tokens ?? 4096) - 1024) * 2
      )
        return {
          decision: "ask_user",
          reason: "This action needs more context than the approval reviewer can safely receive.",
        };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      const response = await fetch(`${connection.url.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        signal: deadline,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model.id,
          stream: false,
          temperature: 0,
          max_tokens: 512,
          messages: [
            { role: "system", content: REVIEW_SYSTEM },
            { role: "user", content: JSON.stringify(request) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`Reviewer API returned ${response.status}`);
      const body = (await response.json()) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
      };
      if (body.choices?.[0]?.finish_reason !== "stop")
        throw new Error("Reviewer response was incomplete");
      // A settings or destination change invalidates an in-flight decision.
      if (
        JSON.stringify(await store.getPermissions()) !== JSON.stringify(settings) ||
        JSON.stringify(await store.getConnection()) !== JSON.stringify(connection)
      )
        throw new Error("Reviewer authorization changed");
      const decision = parseReviewDecision(body.choices[0].message?.content ?? "", request);
      const directory = join(store.layout.root, "approval-reviews");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, `${request.requestId}.json`),
        JSON.stringify({
          request,
          decision,
          model: model.id,
          reviewedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      return decision;
    } catch (error) {
      return {
        decision: "ask_user",
        reason: signal.aborted
          ? "Review cancelled."
          : "Approval reviewer could not complete a valid review. Please review this action.",
      };
    }
  };
}
