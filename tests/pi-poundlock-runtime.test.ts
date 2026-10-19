import {
  AmbiguousInferenceError,
  applyJitter,
  CAPACITY_RETRY,
  type CapacityWaitState,
  capacityPlace,
  clampWait,
  isAmbiguousInferenceFailure,
  isCapacityRejection,
  nextCapacityWait,
  parseRetryAfterMs,
  startCapacityWait,
} from "@core/capacity-retry";
import { PoundlockError } from "@core/poundlock";
import {
  assertReadyPreflight,
  blockedPreflightMessage,
  PreflightCache,
  parsePreflightResult,
  preflightCacheKey,
  shouldInvalidatePreflight,
  tokenFingerprint,
} from "@core/preflight";
import {
  lastApprovedWorkerRevision,
  RoleIsolationError,
  resolveInteractiveWorkerProfile,
} from "@core/role-routing";
import {
  assertWorkflowCanDispatch,
  initialWorkflowCheckpoint,
  newWorkflowIdentity,
} from "@core/workflow-identity";
import { ensurePreflight, wrapStreamForPoundlock } from "@runtime/poundlock-provider";
import { describe, expect, it } from "vitest";

describe("preflight cache", () => {
  it("explains how to replace a token that cannot use external profiles", () => {
    expect(blockedPreflightMessage("external_permission_required")).toContain(
      "replacement token with Call external providers",
    );
  });
  it("keys by controller, token fingerprint, profile UUID, route, and operation", () => {
    const cache = new PreflightCache();
    const key = {
      controller: "http://127.0.0.1:7331/",
      tokenFingerprint: tokenFingerprint("token-a"),
      profileId: "uuid",
      routingRevision: "r1",
      operation: "inference" as const,
    };
    cache.set(key, { operation: "inference", access_state: "ready" });
    expect(cache.get(key)?.access_state).toBe("ready");
    expect(preflightCacheKey({ ...key, controller: "http://127.0.0.1:7331" })).toBe(
      preflightCacheKey(key),
    );
    cache.invalidate({ tokenFingerprint: tokenFingerprint("token-a") });
    expect(cache.get(key)).toBeUndefined();
    expect(shouldInvalidatePreflight({ status: 403 })).toBe(true);
    expect(shouldInvalidatePreflight({ code: "managed_identity_reconciliation_required" })).toBe(
      true,
    );
  });
});

describe("capacity retry", () => {
  it("retries only 409 rejections with bounded Retry-After and jitter", () => {
    const started = startCapacityWait({
      now: 0,
      retryAfterMs: 1_000,
      payloadHash: "same",
      profileId: "uuid",
      routingRevision: "r1",
      tokenFingerprint: "tok",
      operation: "inference",
      random: () => 0.5,
    });
    expect(started.rejectedBeforeInference).toBe(true);
    expect(started.nextWaitMs).toBeGreaterThanOrEqual(CAPACITY_RETRY.minWaitMs);
    expect(parseRetryAfterMs("75")).toBe(CAPACITY_RETRY.maxWaitMs);
    expect(clampWait(500)).toBe(2_000);
    const next = nextCapacityWait(started, {
      now: 5_000,
      retryAfterMs: 5_000,
      liveProfileId: "uuid",
      liveRoutingRevision: "r2",
      liveTokenFingerprint: "tok",
    });
    expect(next.status).toBe("route_changed");
    expect(isAmbiguousInferenceFailure({ message: "socket hang up" }, true)).toBe(true);
    expect(isAmbiguousInferenceFailure({ status: 409, code: "capacity_in_use" }, false)).toBe(
      false,
    );
    expect(new AmbiguousInferenceError("lost").failureClass).toBe("ambiguous_inference");
    expect(applyJitter(10_000, () => 1)).toBeLessThanOrEqual(CAPACITY_RETRY.maxWaitMs);
    expect(isCapacityRejection({ message: "capacity_in_use without a 409" })).toBe(false);
    expect(isCapacityRejection({ status: 409, code: "capacity_in_use" })).toBe(true);
  });

  it("refuses a request for any model but the bound one, before preflight", async () => {
    let preflights = 0;
    let streamed = 0;
    const wrapped = wrapStreamForPoundlock(
      async (_model: unknown) => {
        streamed += 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done" };
          },
        };
      },
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: { id: "local", profileId: "uuid" },
        providerId: "poundlock",
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: ["access_preflight"] },
        preflight: async () => {
          preflights += 1;
          return { operation: "inference", access_state: "ready", profile_id: "uuid" };
        },
      },
    );
    const drain = async (model: unknown) => {
      for await (const _ of wrapped(model) as unknown as AsyncIterable<unknown>);
    };
    await drain({ id: "local", provider: "poundlock" });
    expect(streamed).toBe(1);
    for (const other of [
      { id: "gpt-6", provider: "poundlock" },
      { id: "local", provider: "openai" },
    ])
      await expect(drain(other)).rejects.toThrow(/Refused a request.*Project context was not sent/);
    expect(streamed).toBe(1);
    expect(preflights).toBe(1);
  });

  it("retries 409 capacity inside the same stream without a new turn", async () => {
    let calls = 0;
    const wrapped = wrapStreamForPoundlock(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new PoundlockError("busy", 409, undefined, "capacity_in_use", 2);
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done" };
          },
          result: async () => ({ type: "done" }),
        };
      },
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: { id: "local", profileId: "uuid" },
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: ["access_preflight"] },
        preflight: async () => ({
          operation: "inference",
          access_state: "ready",
          profile_id: "uuid",
        }),
        sleep: async () => undefined,
        random: () => 0.5,
      },
    );
    const stream = wrapped() as unknown as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    expect(calls).toBe(3);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("sends a request whose caller only awaits result(), as Pi's compaction does", async () => {
    let preflights = 0;
    let calls = 0;
    const wrapped = wrapStreamForPoundlock(
      async () => {
        calls += 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done" };
          },
          result: async () => ({ role: "assistant", stopReason: "stop" }),
        };
      },
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: { id: "local", profileId: "uuid" },
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: ["access_preflight"] },
        preflight: async () => {
          preflights += 1;
          return { operation: "inference", access_state: "ready", profile_id: "uuid" };
        },
      },
    );
    const summary = wrapped() as unknown as { result: () => Promise<unknown> };
    await expect(summary.result()).resolves.toEqual({ role: "assistant", stopReason: "stop" });
    expect(calls).toBe(1);
    expect(preflights).toBe(1);

    // A turn reads the events and then asks for the result: still one request.
    const turn = wrapped() as unknown as AsyncIterable<unknown> & {
      result: () => Promise<unknown>;
    };
    for await (const _event of turn);
    await turn.result();
    expect(calls).toBe(2);
  });

  /**
   * What Pi actually does with a 409. Its OpenAI-completions provider catches
   * every HTTP error and emits one `{type:"error"}` event, then ends the stream
   * — it never throws. The retry above only ran on a throw, so in production a
   * busy slot passed straight through as a failed turn. Its tests passed
   * because their fake stream threw. This one behaves like Pi: it calls the
   * `fetch` it was given, sees the 409, and reports it as an event.
   */
  it("waits out a 409 that Pi reports as an error event rather than a throw", async () => {
    let calls = 0;
    const waits: CapacityWaitState[] = [];
    const piLike = async (
      _model: unknown,
      _context: unknown,
      options?: { fetch?: typeof fetch },
    ) => {
      calls += 1;
      const response = await options!.fetch!("http://controller/v1/chat/completions", {
        method: "POST",
      });
      return {
        async *[Symbol.asyncIterator]() {
          if (response.status === 409) {
            yield { type: "error", reason: "error", error: { errorMessage: "409 busy" } };
            return;
          }
          yield { type: "done" };
        },
        result: async () => ({ type: "done" }),
      };
    };
    const busyThenFree = async () =>
      calls < 2
        ? new Response(
            JSON.stringify({
              error: { message: "busy", type: "poundlock_error", code: "capacity_in_use" },
            }),
            { status: 409, headers: { "retry-after": "15" } },
          )
        : new Response("{}", { status: 200 });
    const wrapped = wrapStreamForPoundlock(piLike, {
      controllerUrl: "http://127.0.0.1:9",
      token: "t",
      model: { id: "local", profileId: "uuid" },
      cache: new PreflightCache(),
      capabilities: { api_major: 1, contract_revision: 2, features: [] },
      preflight: async () => ({ operation: "inference", access_state: "ready" }),
      sleep: async () => undefined,
      random: () => 0.5,
      onCapacityWait: async (state) => {
        waits.push(state);
      },
    });
    const events: unknown[] = [];
    const stream = wrapped(undefined, undefined, {
      fetch: busyThenFree as unknown as typeof fetch,
    }) as unknown as AsyncIterable<unknown>;
    for await (const event of stream) events.push(event);
    expect(calls).toBe(2);
    expect(events).toEqual([{ type: "done" }]);
    expect(waits).toHaveLength(1);
    expect(waits[0].status).toBe("waiting");
  });

  it("waits in Poundlock's line: asks to be held, sends its ticket back, says where it stands", async () => {
    const sent: Headers[] = [];
    const waits: CapacityWaitState[] = [];
    const piLike = async (
      _model: unknown,
      _context: unknown,
      options?: { fetch?: typeof fetch },
    ) => {
      const response = await options!.fetch!("http://controller/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer t" },
      });
      return {
        async *[Symbol.asyncIterator]() {
          if (response.status === 409) {
            yield { type: "error", reason: "error", error: { errorMessage: "409 busy" } };
            return;
          }
          yield { type: "done" };
        },
        result: async () => ({ type: "done" }),
      };
    };
    const lineThenSlot = async (_input: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return sent.length < 2
        ? new Response(
            JSON.stringify({
              error: { message: "busy", type: "poundlock_error", code: "capacity_in_use" },
              queue: { position: 2, ticket: "ticket-1", holder_kind: "job", waiting: 2 },
            }),
            { status: 409, headers: { "retry-after": "1" } },
          )
        : new Response("{}", { status: 200 });
    };
    const wrapped = wrapStreamForPoundlock(piLike, {
      queue: { priority: "owner", session: "manager-1" },
      controllerUrl: "http://127.0.0.1:9",
      token: "t",
      model: { id: "local", profileId: "uuid" },
      cache: new PreflightCache(),
      capabilities: { api_major: 1, contract_revision: 5, features: [] },
      preflight: async () => ({ operation: "inference", access_state: "ready" }),
      sleep: async () => undefined,
      random: () => 0.5,
      onCapacityWait: async (state) => {
        waits.push(state);
      },
    });
    const stream = wrapped(undefined, undefined, {
      fetch: lineThenSlot as unknown as typeof fetch,
    }) as unknown as AsyncIterable<unknown>;
    for await (const _event of stream);
    expect(sent).toHaveLength(2);
    expect(sent[0].get("authorization")).toBe("Bearer t");
    expect(sent[0].get("poundlock-wait")).toBe("100");
    expect(sent[0].get("poundlock-priority")).toBe("owner");
    expect(sent[0].get("poundlock-session")).toBe("manager-1");
    expect(sent[0].get("poundlock-queue-ticket")).toBeNull();
    expect(sent[1].get("poundlock-queue-ticket")).toBe("ticket-1");
    expect(waits[0].queue).toEqual({ position: 2, holderKind: "job" });
    expect(capacityPlace(waits[0])).toBe(", 2nd in line behind a job");
  });

  it("passes through an error event that was not a capacity rejection", async () => {
    // A 500 reported by Pi as an event is the model's failure, not a busy
    // slot; it must reach the caller unchanged and must not be retried.
    let calls = 0;
    const wrapped = wrapStreamForPoundlock(
      async (_model: unknown, _context: unknown, options?: { fetch?: typeof fetch }) => {
        calls += 1;
        await options!.fetch!("http://controller/v1/chat/completions", { method: "POST" });
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "error", reason: "error", error: { errorMessage: "500 boom" } };
          },
          result: async () => ({ type: "done" }),
        };
      },
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: { id: "local", profileId: "uuid" },
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: [] },
        preflight: async () => ({ operation: "inference", access_state: "ready" }),
        sleep: async () => undefined,
      },
    );
    const events: unknown[] = [];
    const failing = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    for await (const event of wrapped(undefined, undefined, {
      fetch: failing,
    }) as unknown as AsyncIterable<unknown>)
      events.push(event);
    expect(calls).toBe(1);
    expect(events).toEqual([
      { type: "error", reason: "error", error: { errorMessage: "500 boom" } },
    ]);
  });

  it("does not retry an ambiguous post-submission failure or a capacity-shaped message", async () => {
    let calls = 0;
    const wrapped = wrapStreamForPoundlock(
      async () => {
        calls += 1;
        throw new PoundlockError("capacity_in_use mentioned in text", 500);
      },
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: { id: "local", profileId: "uuid" },
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: [] },
        preflight: async () => ({
          operation: "inference",
          access_state: "ready",
          profile_id: "uuid",
        }),
        sleep: async () => undefined,
      },
    );
    const stream = wrapped() as unknown as AsyncIterable<unknown>;
    await expect(async () => {
      for await (const _event of stream) {
        /* drain */
      }
    }).rejects.toThrow(/capacity_in_use mentioned/);
    expect(calls).toBe(1);

    let startedCalls = 0;
    const afterSubmit = wrapStreamForPoundlock(
      async () => {
        startedCalls += 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "delta" };
            throw new Error("socket hang up");
          },
          result: async () => ({ type: "done" }),
        };
      },
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: { id: "local", profileId: "uuid" },
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: [] },
        preflight: async () => ({
          operation: "inference",
          access_state: "ready",
          profile_id: "uuid",
        }),
      },
    );
    await expect(async () => {
      for await (const _event of afterSubmit() as unknown as AsyncIterable<unknown>) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(AmbiguousInferenceError);
    expect(startedCalls).toBe(1);

    const beforeFirstEvent = wrapStreamForPoundlock(
      () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("socket hang up before the first event");
        },
        result: async () => ({ type: "done" }),
      }),
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: { id: "local", profileId: "uuid" },
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: [] },
        preflight: async () => ({ operation: "inference", access_state: "ready" }),
      },
    );
    await expect(async () => {
      for await (const _event of beforeFirstEvent() as unknown as AsyncIterable<unknown>) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(AmbiguousInferenceError);
  });

  it("stops a 409 retry when the live profile UUID or route changes", async () => {
    let calls = 0;
    const waits: string[] = [];
    const wrapped = wrapStreamForPoundlock(
      async () => {
        calls += 1;
        throw new PoundlockError("busy", 409, undefined, "capacity_in_use", 1);
      },
      {
        controllerUrl: "http://127.0.0.1:9",
        token: "t",
        model: {
          id: "local",
          profileId: "uuid",
          routingRevision: "r1",
          dataDestination: "operator_network",
        },
        cache: new PreflightCache(),
        capabilities: { api_major: 1, contract_revision: 2, features: [] },
        preflight: async () => ({
          operation: "inference",
          access_state: "ready",
          profile_id: "uuid",
        }),
        sleep: async () => undefined,
        random: () => 0.5,
        refreshLiveRoute: async () => ({
          profileId: "other-uuid",
          routingRevision: "r1",
          tokenFingerprint: tokenFingerprint("t"),
          dataDestination: "operator_network",
        }),
        onCapacityWait: async (state) => {
          waits.push(state.status);
        },
      },
    );
    await expect(async () => {
      for await (const _event of wrapped() as unknown as AsyncIterable<unknown>) {
        /* drain */
      }
    }).rejects.toThrow(/route changed/);
    expect(calls).toBe(1);
    expect(waits).toEqual(["route_changed"]);
  });
});

describe("preflight fail-closed", () => {
  const base = {
    controllerUrl: "http://127.0.0.1:9",
    token: "t",
    model: { id: "local", profileId: "uuid", routingRevision: "r1" },
    cache: new PreflightCache(),
    capabilities: {
      api_major: 1,
      contract_revision: 2,
      features: ["access_preflight"] as string[],
    },
  };

  it("rejects blocked, malformed, and advertised-but-missing preflight responses", async () => {
    await expect(
      ensurePreflight({
        ...base,
        cache: new PreflightCache(),
        preflight: async () => ({
          operation: "inference",
          access_state: "blocked",
          blocked_reason: "data_destination_confirmation_required",
        }),
      }),
    ).rejects.toThrow(/blocked/i);
    await expect(
      ensurePreflight({
        ...base,
        cache: new PreflightCache(),
        preflight: async () => "not-json-object",
      }),
    ).rejects.toThrow(/malformed/);
    await expect(
      ensurePreflight({
        ...base,
        cache: new PreflightCache(),
        preflight: async () => {
          throw new PoundlockError("missing", 404);
        },
      }),
    ).rejects.toThrow(/advertised access_preflight/);
    expect(() => parsePreflightResult(null, "inference")).toThrow(/malformed/);
    expect(() => parsePreflightResult({ access_state: "ready" }, "inference")).toThrow(/operation/);
    expect(() =>
      assertReadyPreflight(
        { operation: "inference", access_state: "ready" },
        { operation: "inference", profileId: "uuid" },
      ),
    ).toThrow(/profile identity/);
    expect(() =>
      assertReadyPreflight(
        { operation: "inference", access_state: "ready", profile_id: "uuid" },
        { operation: "inference", profileId: "uuid", destination: "operator_network" },
      ),
    ).toThrow(/data destination/);
    expect(
      assertReadyPreflight(
        {
          operation: "inference",
          access_state: "ready",
          profile_id: "uuid",
          data_destination: "operator_network",
        },
        { operation: "inference", profileId: "uuid", destination: "operator_network" },
      ).profile_id,
    ).toBe("uuid");
    expect(() =>
      assertReadyPreflight(
        { operation: "inference", access_state: "ready", destination: "external" },
        { operation: "inference", destination: "operator_network" },
      ),
    ).toThrow(/destination/);
  });

  it("skips preflight only when capabilities omit the feature", async () => {
    let called = 0;
    await ensurePreflight({
      ...base,
      capabilities: { api_major: 1, contract_revision: 2, features: [] },
      preflight: async () => {
        called += 1;
        return { operation: "inference", access_state: "ready" };
      },
    });
    expect(called).toBe(0);
  });
});

describe("strict role isolation", () => {
  it("will not use a manager-only profile as a worker even when it is idle and larger", () => {
    const models = [
      {
        id: "worker",
        profileId: "worker-uuid",
        context_tokens: 8192,
        max_output_tokens: 2048,
        workload_class: "interactive-coding",
        busy: true,
      },
      {
        id: "frontier-deepseek-flash",
        profileId: "manager-uuid",
        context_tokens: 131072,
        max_output_tokens: 8192,
        workload_class: "interactive-coding",
        busy: false,
      },
    ];
    const roles = {
      manager: {
        profileId: "manager-uuid",
        profileName: "frontier-deepseek-flash",
        source: "interactive" as const,
      },
      interactive: {
        profileId: "worker-uuid",
        profileName: "worker",
        source: "interactive" as const,
      },
    };
    const project = {
      policy: { allowedWorkerProfileIds: [], managerModel: "" },
      managerEscalation: undefined,
    } as never;
    const selected = resolveInteractiveWorkerProfile(
      models,
      roles,
      project,
      {
        difficulty: "large",
        attempts: [],
      },
      { url: "", token: "", roles },
    );
    expect(selected.profileId).toBe("worker-uuid");
    const withExtras = {
      policy: { allowedWorkerProfileIds: ["manager-uuid"], managerModel: "" },
      managerEscalation: undefined,
    } as never;
    expect(
      resolveInteractiveWorkerProfile(
        models,
        roles,
        withExtras,
        {
          difficulty: "large",
          attempts: [],
        },
        { url: "", token: "", roles },
      ).profileId,
    ).toBe("worker-uuid");
    expect(() =>
      resolveInteractiveWorkerProfile(
        models.filter((model) => model.profileId === "manager-uuid"),
        roles,
        project,
        { difficulty: "small", attempts: [] },
        { url: "", token: "", roles },
      ),
    ).toThrow(RoleIsolationError);
  });

  it("validates the selected alternate or escalation route, not the default worker role", () => {
    const selected = {
      id: "alt",
      profileId: "alt-uuid",
      routingRevision: "alt-r2",
    };
    const roles = {
      interactive: {
        profileId: "worker-uuid",
        profileName: "worker",
        source: "interactive" as const,
        lastApprovedRoutingRevision: "worker-r1",
        routingRevision: "worker-r1",
      },
    };
    expect(
      lastApprovedWorkerRevision(
        {
          attempts: [
            {
              profileId: "alt-uuid",
              routingRevision: "alt-r1",
            },
          ],
        } as never,
        selected,
        roles,
      ),
    ).toBe("alt-r1");
    expect(
      lastApprovedWorkerRevision(
        {
          escalation: { routingRevision: "esc-r9" },
          attempts: [],
        } as never,
        selected,
        roles,
      ),
    ).toBe("esc-r9");
  });
});

describe("workflow identity", () => {
  it("keeps Pi conversation restoration from dispatching work", () => {
    const identity = newWorkflowIdentity();
    expect(identity.workflowId).not.toBe(identity.managerConversationId);
    const checkpoint = initialWorkflowCheckpoint(identity);
    expect(() => assertWorkflowCanDispatch(checkpoint)).toThrow(/cannot start or repeat work/);
    expect(() =>
      assertWorkflowCanDispatch({ ...checkpoint, dispatchAuthorized: true }),
    ).not.toThrow();
  });
});
