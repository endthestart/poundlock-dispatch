# ADR 006 — Qualified selection and explicit escalation authority

Status: Accepted; revised by owner confirmation 2026-09-13. Supersedes the earlier
snippet → interactive → durable → off-box ladder. The existing role map is an MVP
configuration mechanism; generalized automatic routing and budgets are future work.

## Decision

Separate role (manager/worker), execution path (interactive/durable), qualified
capability and destination. Durable is not a model-strength tier. LiteLLM and model
names establish neither destination nor quality. Tiny/small/medium/large are
operator-defined qualified pools, not universal ranks based on parameter count.

Users describe objectives and approve constraints. The manager chooses within an
eligible set filtered by deterministic permissions, tools, context, destination
and budgets, considering expected success, latency/wake/load and known cost.
It may start with a strong model for a hard task. Qualification identifies the
model, harness, tools, context/output limits and inference settings; missing/stale
evidence is unknown. Per-profile reasoning controls require explicit qualification.

After terminal/reconciled failed work, an evidence-based repair or capability
escalation becomes a recorded new attempt with frozen profile/settings/inputs.
Busy capacity, sleeping nodes and network failures call for waiting/preparation
or recovery, not automatic promotion. Never replay already executed tools blindly.

## Approved escalation modes

| Mode | Behavior |
|---|---|
| Ask every time | Obtain approval for each escalation, showing target/destination, relevant data, reason and known/estimated cost. |
| Standing authorization | Escalate automatically within approved profiles/destinations, data/tool scope and run limits. No prompt for every transition. |
| Budget-aware automatic | Standing scope plus a valid budget decision permits escalation; insufficient, stale, unknown or unenforceable required budget evidence follows the configured ask/wait/stop policy. |

Policy may differ by transition: private-medium → private-large automatically,
external frontier only after approval. "Always allowed" is standing authority,
not arbitrary providers, new tools, unlimited spend or permission to disclose
secrets. Organization denials/hard limits cannot be bypassed by user approval.
A source upload to durable execution is separately authorized from inference.
Record automatic decisions; explicit behavior does not require repeated prompts
when the transition is already authorized.

Budget visibility is not enforcement. A gateway balance can be stale or consumed
concurrently. Hard-budget policy requires authoritative admission/reservation or
verified upstream enforcement with known overshoot behavior. Client/model arithmetic
cannot provide a hard ceiling. Account for manager/worker/retries and interrupted
requests across restart. Expose scoped source/unit/window/freshness and unknowns,
not gateway credentials; an available budget does not authorize data disclosure.
The current server does not promise this budget-discovery/admission contract.

The client uses published Poundlock profiles and its existing access token for
external escalation. No second provider credential or direct gateway bypass.
Current GUI acceptance does not require implementing these future budget modes.
Preserve current explicit user bindings/consents until their replacement is tested.

## GUI follow-up

ADR 011 implements an ordered list, manager-coordinated requests, ask/standing
authorization and bounded transitions. Monetary budget discovery/admission remains
future work; standing authorization is not a hard-budget claim.
