# Poundlock API contract

Dispatch uses one application token for controller discovery, interactive inference
and the manual durable jobs of `dispatch jobs`. Configure the operator's published
profile IDs; aliases are alternate names for the same profile, not extra runtime
capacity.

The manager and attached workers use the OpenAI-compatible `/v1` endpoint. Pi is
pinned to 1.1.0. The client retains advertised context/output limits and explicit
reasoning preferences; a qualification report must match that harness and setup.
Discovery and busy status are advisory. Admission remains authoritative.
`GET /api/v1/capabilities` reports API major 1. Poundlock 0.3.0 publishes contract
revision 5: revision 4 added `reasoning_levels`, `route_catalog` and `model_status`,
and 5 the capacity queue. Dispatch accepts any revision at or above 3 and requires
only the features in `compat/poundlock.json`.
Inference calls `POST /api/v1/access/preflight` before sending project context.
HTTP 409 `capacity_in_use` retries the same request after `Retry-After`; lost or
malformed post-submission streams are not retried.

`data_destination` is `operator_network`, `external`, or `unknown`. Adapter type,
model name and physical machine location do not determine it. Source upload is a
separate decision from inference. A manual job (`dispatch jobs submit`) uses
`/api/v1/jobs` with an idempotency key derived from its input, so resubmitting the
same input returns the same job. Results include actual verification and patches.

Wake/load preparation can take minutes. The client allows preparation plus inference
within a cancellable 21-minute request deadline. Capacity errors back off; timeout
or interrupted tools are reconciled rather than blindly replayed. Reopening does
not start new local work, manager decisions or repairs.

Start with the Poundlock family's operator guide: prepare and qualify infrastructure
with Toolkit, register profiles in Poundlock, then map those profiles in Dispatch.
There is no automatic qualification importer, generalized optimal router or hard
budget enforcement in this GUI release.
