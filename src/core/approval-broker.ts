import { randomUUID } from "node:crypto";
import type { ToolApproval, ToolApprovalDecision } from "@shared/permissions";
import { sha256Text } from "./ids.js";

export class ApprovalBroker {
  private requests = new Map<string, { view: ToolApproval; resolve: (allowed: boolean) => void }>();
  private grants = new Set<string>();
  private pendingByKey = new Map<string, Promise<boolean>>();
  constructor(private changed: () => void = () => {}) {}
  list(): ToolApproval[] {
    return [...this.requests.values()].map((item) => item.view);
  }
  async request(input: Omit<ToolApproval, "id">, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const key = sha256Text(
      JSON.stringify([input.projectId, input.planRevision, input.kind, input.action]),
    );
    if (this.grants.has(key)) return true;
    const existing = this.pendingByKey.get(key);
    if (existing) return existing;
    // Registering stays synchronous: a caller that requests and then reads the
    // list must see its own request, and an identical concurrent request must
    // find it to coalesce against.
    const pending = new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const finish = (allowed: boolean) => {
        this.requests.delete(id);
        signal?.removeEventListener("abort", abort);
        this.changed();
        resolve(allowed);
      };
      const abort = () => finish(false);
      this.requests.set(id, { view: { ...input, id }, resolve: finish });
      signal?.addEventListener("abort", abort, { once: true });
    });
    this.pendingByKey.set(key, pending);
    void pending.finally(() => {
      if (this.pendingByKey.get(key) === pending) this.pendingByKey.delete(key);
    });
    this.changed();
    return pending;
  }
  decide(id: string, decision: ToolApprovalDecision): void {
    const item = this.requests.get(id);
    if (!item) return;
    if (decision === "always") {
      const v = item.view;
      this.grants.add(sha256Text(JSON.stringify([v.projectId, v.planRevision, v.kind, v.action])));
    }
    item.resolve(decision === "once" || decision === "always");
  }
  /**
   * Re-evaluate pending approvals against a policy change. `decide` returns
   * `true` to grant, `false` to deny, or `undefined` to leave the card pending
   * for the user. A policy edit must never force-deny approvals it has no
   * opinion about (e.g. inference consent, which trust mode never
   * governs) — that would silently stop an unrelated in-flight run.
   */
  recheck(decide: (view: ToolApproval) => boolean | undefined): void {
    for (const item of [...this.requests.values()]) {
      const outcome = decide(item.view);
      if (outcome !== undefined) item.resolve(outcome);
    }
  }
  clear(): void {
    this.grants.clear();
    for (const item of [...this.requests.values()]) item.resolve(false);
  }
  cancel(projectId: string): void {
    for (const item of [...this.requests.values()])
      if (item.view.projectId === projectId) item.resolve(false);
  }
}
