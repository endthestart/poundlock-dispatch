import type { PoundlockCapabilities } from "@core/capabilities";
import {
  AmbiguousInferenceError,
  CAPACITY_RETRY,
  type CapacityWaitState,
  capacityIdentityChanged,
  isAmbiguousInferenceFailure,
  isCapacityRejection,
  nextCapacityWait,
  parseRetryAfterMs,
  startCapacityWait,
} from "@core/capacity-retry";
import { sha256Text } from "@core/ids";
import { PoundlockClient, PoundlockError } from "@core/poundlock";
import {
  assertReadyPreflight,
  PreflightCache,
  type PreflightOperation,
  parsePreflightResult,
  preflightCacheKey,
  shouldInvalidatePreflight,
  tokenFingerprint,
} from "@core/preflight";
import { reasoningLabel } from "@shared/reasoning";
import type { InteractiveModel, ReasoningChoice } from "@shared/types";

export const sharedPreflightCache = new PreflightCache();

/** Who a request is for, in Poundlock's line: a person waiting, planning, or work. */
export type QueuePriority = "owner" | "planner" | "worker" | "background";

/**
 * How long Poundlock holds a request for a busy model before its 409: under
 * its own 110 s limit and the hub proxy's timeout.
 */
export const QUEUE_WAIT_SECONDS = 100;

export interface PoundlockProviderOptions {
  /** This client's place in Poundlock's line: its class and conversation. */
  queue?: { priority: QueuePriority; session?: string };
  controllerUrl: string;
  token: string;
  model: InteractiveModel;
  providerId?: string;
  operation?: PreflightOperation;
  capabilities?: PoundlockCapabilities;
  fetchCapabilities?: (signal?: AbortSignal) => Promise<PoundlockCapabilities>;
  preflight: (
    model: string,
    operation: PreflightOperation,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  cache: PreflightCache;
  lastApprovedRoutingRevision?: string;
  onCapacityWait?: (state: CapacityWaitState) => void | Promise<void>;
  refreshLiveRoute?: (signal?: AbortSignal) => Promise<{
    profileId: string;
    routingRevision: string;
    tokenFingerprint: string;
    dataDestination: string;
  }>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/**
 * The provider settings every worker session uses: the bound profile, its
 * access preflight (once per route, cached), capacity waits, and a check that
 * the route is still the one approved before a rejected request is resent.
 */
export function workerProviderOptions(input: {
  controllerUrl: string;
  token: string;
  model: InteractiveModel;
  capabilities?: PoundlockCapabilities;
  lastApprovedRoutingRevision?: string;
  onCapacityWait?: (state: CapacityWaitState) => void | Promise<void>;
  /** The worker's conversation, so a released slot comes back to it first. */
  session?: string;
}): Omit<PoundlockProviderOptions, "model" | "controllerUrl" | "token" | "providerId"> {
  const client = () => new PoundlockClient(input.controllerUrl, input.token);
  return {
    queue: { priority: "worker", ...(input.session ? { session: input.session } : {}) },
    cache: sharedPreflightCache,
    lastApprovedRoutingRevision: input.lastApprovedRoutingRevision ?? input.model.routingRevision,
    capabilities: input.capabilities,
    fetchCapabilities: async () => client().capabilities(),
    refreshLiveRoute: async () => {
      const models = await client().listInteractiveModels();
      const boundProfileId = input.model.profileId ?? input.model.id;
      const live = models.find((model) => (model.profileId ?? model.id) === boundProfileId);
      if (!live) {
        throw new Error(
          "The bound worker profile is no longer advertised. The rejected request was not resent.",
        );
      }
      return {
        profileId: live.profileId ?? live.id,
        routingRevision: live.routingRevision ?? "",
        tokenFingerprint: tokenFingerprint(input.token),
        dataDestination: live.dataDestination ?? "",
      };
    },
    onCapacityWait: input.onCapacityWait,
    preflight: async (model, operation, abort) => client().preflight({ model, operation }, abort),
  };
}

interface RegisteredPoundlockModel {
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

/** Pi's own names for the explicit levels; each is sent upstream unchanged. */
const PI_EXPLICIT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The model as Pi sees it. With no verified levels Pi never sends a reasoning
 * parameter, and Poundlock's profile default applies. With verified levels Pi
 * may send `reasoning_effort`, but only a verified one: every other level maps
 * to null, so Pi's clamp has nothing to substitute. `off` stays unmapped, so an
 * omitted choice sends nothing.
 */
export function poundlockModelDefinition(model: InteractiveModel) {
  const verified = model.reasoningLevels ?? [];
  const reasoning = verified.length > 0;
  // Anthropic caches only the prompt it is told to, and passes the markers
  // through Poundlock and LiteLLM; unmarked, a frontier Planner review re-sent
  // about a million input tokens. Its cache reads cost a
  // tenth of input and its writes a quarter more.
  const anthropic = model.provider === "anthropic";
  const input = model.pricing?.inputPerMtok ?? 0;
  return {
    id: model.id,
    name: model.id,
    reasoning,
    ...(reasoning
      ? {
          thinkingLevelMap: Object.fromEntries(
            PI_EXPLICIT_LEVELS.map((level) => [
              level,
              (verified as readonly string[]).includes(level) ? level : null,
            ]),
          ),
        }
      : {}),
    input: ["text"] as Array<"text">,
    contextWindow: model.context_tokens ?? 0,
    maxTokens: model.max_output_tokens ?? 0,
    // The catalog's estimate per million tokens, so every session reports what
    // it cost. Cached input is priced as input where the provider's cache price
    // is unknown: an overestimate, as a cap wants.
    cost: {
      input,
      output: model.pricing?.outputPerMtok ?? 0,
      cacheRead: anthropic ? input * 0.1 : input,
      cacheWrite: anthropic ? input * 1.25 : input,
    },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: reasoning,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens" as const,
      // No strict tool schemas. Pi 0.86 makes every optional argument required
      // under strict sampling, and local models then fill them in: a 30-second
      // bash timeout or a 100-line read limit on every call.
      supportsStrictMode: false,
      ...(anthropic ? { cacheControlFormat: "anthropic" as const } : {}),
    },
  };
}

type PayloadHook = (payload: unknown, model: never) => unknown;

/**
 * Stream options that carry one turn's reasoning choice, and a last check on
 * the payload Pi built: the request goes out with exactly the chosen
 * `reasoning_effort` — absent for Model default — or not at all. Pi has no
 * `none` level, so `none` is written into the payload directly.
 */
export function applyReasoning<O extends { reasoning?: unknown; onPayload?: unknown }>(
  options: O | undefined,
  choice: ReasoningChoice,
): O & { reasoning?: string; onPayload: (payload: unknown, model: never) => Promise<unknown> } {
  const prior = options?.onPayload as PayloadHook | undefined;
  const expected = choice === "model_default" ? undefined : choice;
  const onPayload = async (payload: unknown, model: never) => {
    const next = ((await prior?.(payload, model)) ?? payload) as Record<string, unknown>;
    if (choice === "none") next.reasoning_effort = "none";
    if (next.reasoning_effort !== expected)
      throw new Error(
        `Dispatch stopped a request that would have sent reasoning "${String(
          next.reasoning_effort ?? "omitted",
        )}" when ${reasoningLabel(choice)} was chosen. Nothing was sent.`,
      );
    return next;
  };
  return {
    ...(options ?? ({} as O)),
    reasoning: choice === "model_default" || choice === "none" ? undefined : choice,
    onPayload,
  };
}

export async function ensurePreflight(
  options: PoundlockProviderOptions,
  signal?: AbortSignal,
): Promise<void> {
  if (options.providerId === "local-manager") return;
  const capabilities = await resolveCapabilities(options, signal);
  if (!capabilities.features.includes("access_preflight")) return;
  const operation = options.operation ?? "inference";
  const profileId = options.model.profileId ?? options.model.id;
  const routingRevision = options.model.routingRevision ?? "";
  if (
    options.lastApprovedRoutingRevision &&
    routingRevision &&
    options.lastApprovedRoutingRevision !== routingRevision
  ) {
    throw new Error(
      "The selected profile route changed in Poundlock. Review destination and routing before sending project context.",
    );
  }
  const key = {
    controller: options.controllerUrl,
    tokenFingerprint: tokenFingerprint(options.token),
    profileId,
    routingRevision,
    operation,
  };
  if (options.cache.get(key)) return;
  let raw: unknown;
  try {
    raw = await options.preflight(options.model.id, operation, signal);
  } catch (error) {
    const status = error instanceof PoundlockError ? error.status : undefined;
    if (status === 404 || status === 405) {
      throw new Error(
        "Poundlock advertised access_preflight but the preflight endpoint is missing. Project context was not sent.",
      );
    }
    throw error instanceof Error
      ? error
      : new Error("Poundlock preflight request failed. Project context was not sent.");
  }
  const result = assertReadyPreflight(parsePreflightResult(raw, operation), {
    operation,
    profileId,
    model: options.model.id,
    destination: options.model.dataDestination,
  });
  options.cache.set(key, result);
}

async function resolveCapabilities(
  options: PoundlockProviderOptions,
  signal?: AbortSignal,
): Promise<PoundlockCapabilities> {
  if (options.capabilities) return options.capabilities;
  if (!options.fetchCapabilities) {
    throw new Error("Poundlock capabilities are required before sending project context.");
  }
  const capabilities = await options.fetchCapabilities(signal);
  options.capabilities = capabilities;
  return capabilities;
}

/**
 * Refuse a request for any model but the one this stream was built for.
 *
 * Dispatch picks that model from the role binding and its consent. Anything
 * else choosing another (a model picker, a restored session, a provider added
 * by login) would send project context somewhere nobody approved. The wrapper
 * sees every request, so this is where the binding is enforced.
 */
function assertBoundModel(args: unknown[], options: PoundlockProviderOptions): void {
  const selected = args[0];
  if (!selected || typeof selected !== "object" || !("id" in selected)) return;
  const { id, provider } = selected as { id?: unknown; provider?: unknown };
  const expected = options.providerId ?? "poundlock";
  if (id === options.model.id && (provider === undefined || provider === expected)) return;
  throw new Error(
    `Refused a request to ${String(provider ?? "an unknown provider")}/${String(id)}: this session is bound to ${expected}/${options.model.id}. Project context was not sent.`,
  );
}

type StreamResult = {
  result?: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

export function wrapStreamForPoundlock<TArgs extends unknown[], TResult>(
  stream: (...args: TArgs) => TResult,
  options: PoundlockProviderOptions,
): (...args: TArgs) => TResult {
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Cancelled"));
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Cancelled"));
          },
          { once: true },
        );
      }));
  return ((...args: TArgs) => {
    const signal = findSignal(args);
    const payloadHash = sha256Text(JSON.stringify(args.slice(0, 2)));
    let inner: StreamResult | undefined;
    const iterator = (async function* () {
      assertBoundModel(args, options);
      await ensurePreflight(options, signal);
      let wait: CapacityWaitState | undefined;
      // The place a request kept in Poundlock's line, sent back to keep it.
      let ticket: string | undefined;
      while (true) {
        if (signal?.aborted) throw new Error("Cancelled");
        let started = false;
        let handedToProvider = false;
        let rejected: CapacityRejection | undefined;
        try {
          handedToProvider = true;
          const observed = observeCapacityRejection(
            args,
            (rejection) => {
              rejected = rejection;
            },
            queueHeaders(options, ticket),
          );
          inner = (await Promise.resolve(stream(...observed))) as StreamResult;
          for await (const event of iterable(inner)) {
            // Pi reports an HTTP failure as a single error event and ends the
            // stream; it never throws. So the rejection is recognised from the
            // response the provider actually received, and raised here into
            // the same path a thrown one takes.
            if (!started && rejected && isErrorEvent(event)) throw rejected;
            started = true;
            yield event;
          }
          return;
        } catch (error) {
          const mapped = asPoundlockError(error);
          if (mapped && shouldInvalidatePreflight(mapped)) {
            options.cache.invalidate({
              controller: options.controllerUrl,
              tokenFingerprint: tokenFingerprint(options.token),
            });
          }
          if (mapped && isCapacityRejection(mapped) && !started) {
            const place = (error as CapacityRejection | undefined)?.queue;
            ticket = place?.ticket;
            const retryAfter = parseRetryAfterMs(headerFrom(error));
            const originalIdentity = {
              profileId: options.model.profileId ?? options.model.id,
              routingRevision: options.model.routingRevision ?? "",
              tokenFingerprint: tokenFingerprint(options.token),
              dataDestination: options.model.dataDestination ?? "",
            };
            const liveRoute = options.refreshLiveRoute
              ? await options.refreshLiveRoute(signal)
              : originalIdentity;
            const live = {
              now: (options.now ?? Date.now)(),
              retryAfterMs: retryAfter,
              liveProfileId: liveRoute.profileId,
              liveRoutingRevision: liveRoute.routingRevision,
              liveTokenFingerprint: liveRoute.tokenFingerprint,
              liveDataDestination: liveRoute.dataDestination,
              random: options.random,
            };
            if (!wait) {
              if (capacityIdentityChanged(originalIdentity, live)) {
                wait = {
                  ...startCapacityWait({
                    now: live.now,
                    retryAfterMs: retryAfter,
                    payloadHash,
                    ...originalIdentity,
                    operation: options.operation ?? "inference",
                    random: options.random,
                  }),
                  status: "route_changed",
                  nextWaitMs: 0,
                };
              } else {
                wait = startCapacityWait({
                  now: live.now,
                  retryAfterMs: retryAfter,
                  payloadHash,
                  ...originalIdentity,
                  operation: options.operation ?? "inference",
                  random: options.random,
                });
              }
            } else {
              wait = nextCapacityWait(wait, live);
            }
            if (place)
              wait = {
                ...wait,
                queue: {
                  position: place.position,
                  ...(place.holder_kind ? { holderKind: place.holder_kind } : {}),
                },
              };
            await options.onCapacityWait?.(wait);
            if (wait.status !== "waiting") {
              throw new Error(
                wait.status === "route_changed"
                  ? "The selected route changed while waiting for capacity. The rejected request was not resent."
                  : wait.status === "paused"
                    ? "Capacity wait paused. The rejected request was not resent."
                    : wait.status === "cancelled"
                      ? "Capacity wait cancelled. The rejected request was not resent."
                      : "Poundlock capacity_in_use wait exhausted. The original request was not resent after the deadline.",
              );
            }
            await sleep(wait.nextWaitMs, signal);
            await ensurePreflight(options, signal);
            continue;
          }
          if (
            isAmbiguousInferenceFailure(
              mapped ?? { message: String(error) },
              handedToProvider || started,
            )
          ) {
            throw new AmbiguousInferenceError(
              "The inference request may already have started. Dispatch will not retry it automatically.",
            );
          }
          throw error;
        }
      }
    })();
    let consumed = false;
    return {
      [Symbol.asyncIterator]: () => {
        consumed = true;
        return iterator;
      },
      // Pi's compaction and branch summaries await `result()` without reading
      // the events. Reading them here sends that request through the same
      // binding, preflight and capacity checks as a turn; refusing it, as this
      // did, left every compaction failing before it reached the model.
      result: async () => {
        if (!consumed) {
          consumed = true;
          let step = await iterator.next();
          while (!step.done) step = await iterator.next();
        }
        if (inner?.result) return inner.result();
        throw new Error("Inference stream did not complete.");
      },
    } as TResult;
  }) as (...args: TArgs) => TResult;
}

/** A 409 `capacity_in_use` seen on the wire, shaped for `isCapacityRejection`. */
interface CapacityRejection {
  status: 409;
  code: "capacity_in_use";
  message: string;
  retryAfter?: string;
  /** Where the request stands, from a controller that keeps a line (revision 5). */
  queue?: { position: number; ticket?: string; holder_kind?: "interactive" | "job" };
}

/**
 * Ask Poundlock to hold the request in line rather than refuse it at once.
 * A controller before contract revision 5 ignores these headers.
 */
function queueHeaders(options: PoundlockProviderOptions, ticket?: string): Record<string, string> {
  return {
    "Poundlock-Wait": String(QUEUE_WAIT_SECONDS),
    "Poundlock-Priority": options.queue?.priority ?? "worker",
    ...(options.queue?.session ? { "Poundlock-Session": options.queue.session.slice(0, 128) } : {}),
    ...(ticket ? { "Poundlock-Queue-Ticket": ticket } : {}),
  };
}

/**
 * Give the provider a `fetch` that notices a capacity rejection.
 *
 * Pi's OpenAI-completions provider forwards `options.fetch` to its HTTP client
 * and turns every error status into an error *event*, formatted as text. Its
 * wording is Pi's to change, so the decision is made from the response itself
 * — status, the controller's error code, and its `Retry-After` — before Pi
 * formats anything. The response is returned untouched.
 */
function observeCapacityRejection<TArgs extends unknown[]>(
  args: TArgs,
  onRejection: (rejection: CapacityRejection) => void,
  extraHeaders: Record<string, string> = {},
): TArgs {
  const options = (args[2] ?? {}) as { fetch?: typeof fetch };
  const base = options.fetch ?? globalThis.fetch;
  const observing = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    const response = await base(input, { ...init, headers });
    if (response.status === 409) {
      try {
        const body = (await response.clone().json()) as {
          error?: { code?: string; message?: string };
          queue?: CapacityRejection["queue"];
        };
        if (body.error?.code === "capacity_in_use") {
          const retryAfter = response.headers.get("retry-after");
          onRejection({
            status: 409,
            code: "capacity_in_use",
            message: body.error.message ?? "capacity_in_use",
            // Absent rather than undefined: `headerFrom` stringifies the key.
            ...(retryAfter ? { retryAfter } : {}),
            ...(body.queue && typeof body.queue.position === "number" ? { queue: body.queue } : {}),
          });
        }
      } catch {
        // Not Poundlock's JSON error: not a capacity rejection.
      }
    }
    return response;
  }) as typeof fetch;
  const observed = [...args];
  observed[2] = { ...options, fetch: observing };
  return observed as TArgs;
}

function isErrorEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "error",
  );
}

function iterable(value: StreamResult): AsyncIterable<unknown> {
  return value;
}

function findSignal(args: unknown[]): AbortSignal | undefined {
  for (const arg of args) {
    if (arg instanceof AbortSignal) return arg;
    if (
      arg &&
      typeof arg === "object" &&
      "signal" in arg &&
      (arg as { signal?: AbortSignal }).signal
    ) {
      return (arg as { signal?: AbortSignal }).signal;
    }
  }
  return undefined;
}

function asPoundlockError(
  error: unknown,
): { status?: number; code?: string; message?: string } | undefined {
  if (error instanceof PoundlockError) return error;
  if (error && typeof error === "object")
    return error as { status?: number; code?: string; message?: string };
  return { message: String(error) };
}

function headerFrom(error: unknown): string | undefined {
  if (error instanceof PoundlockError)
    return error.retryAfterSeconds != null ? String(error.retryAfterSeconds) : undefined;
  if (error && typeof error === "object" && "retryAfter" in error) {
    return String((error as { retryAfter?: unknown }).retryAfter);
  }
  return undefined;
}

export { preflightCacheKey, CAPACITY_RETRY };
