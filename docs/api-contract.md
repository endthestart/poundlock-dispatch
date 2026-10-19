# Poundlock API contract

Dispatch uses one application token for controller discovery, interactive inference
and durable jobs. Configure the operator's published profile IDs; aliases are
alternate names for the same profile, not extra runtime capacity.

The manager and attached workers use the OpenAI-compatible `/v1` endpoint. Pi is
pinned to 0.86.1. The client retains advertised context/output limits and explicit
reasoning preferences; a qualification report must match that harness and setup.
Discovery and busy status are advisory. Admission remains authoritative.
`GET /api/v1/capabilities` reports API major 1. Poundlock now publishes contract
revision 4, adding `reasoning_levels`, `route_catalog`, and `model_status`; Dispatch
accepts any revision at or above 3 and does not yet require the revision-4 fields.
Interactive inference and durable jobs call `POST /api/v1/access/preflight` before
sending project context. HTTP 409 `capacity_in_use` retries the same request after
`Retry-After`; lost or malformed post-submission streams are not retried.

`data_destination` is `operator_network`, `external`, or `unknown`. Adapter type,
model name and physical machine location do not determine it. Source upload is a
separate decision from inference. Durable jobs use `/api/v1/jobs` with a persisted
immutable request and idempotency key before submission. Lost acknowledgements
retry only the original request. Results include actual verification and patches.

Wake/load preparation can take minutes. The client allows preparation plus inference
within a cancellable 21-minute request deadline. Capacity errors back off; timeout
or interrupted tools are reconciled rather than blindly replayed. Reopening does
not start new local work, manager decisions or repairs; already-owned durable jobs
may still be observed.

Start with the Poundlock family's operator guide: prepare and qualify infrastructure
with Toolkit, register profiles in Poundlock, then map those profiles in Dispatch.
There is no automatic qualification importer, generalized optimal router or hard
budget enforcement in this GUI release.
