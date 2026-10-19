# ADR 004 — One Poundlock URL; discover models as profiles

Status: Accepted, 2026-09-11.

Poundlock Dispatch requires a Poundlock controller. Application tokens authenticate
worker execution, durable jobs, managed frontier access and server discovery.
Interactive profiles come from `/v1`; durable workers come from
`/api/v1/job-options`.

The Project Manager normally uses one of those Poundlock profiles. A narrow
same-computer exception may instead use a user-configured OpenAI-compatible
loopback address. This keeps worker execution and escalation under Poundlock
while allowing private planning on the Dispatch computer. The exception accepts
only loopback HTTP(S), stores its token with other local credentials and cannot
be used as a worker or frontier route.

LiteLLM, Ollama, and other backends stay Poundlock operator configuration.
Frontier models appear in Poundlock Dispatch only as Poundlock profiles, with a visible
local vs remote (leaves this computer) distinction.

Poundlock Dispatch discovers profiles from two client APIs (one Poundlock token):

- `GET /v1/models` — saved profiles for inference, including aliases. Alias
  rows collapse to one profile. This list is **not** filtered by endpoint check
  status.
- `GET /api/v1/job-options` — durable-agent profiles only.

A gateway endpoint must have saved model profiles before those profiles appear
in discovery. Configure and qualify the profiles in Poundlock, then test the
connection again in Dispatch.

Inference destination is described by `data_destination` or an explicit operator
preference. Names, aliases, adapter types and `endpoint_kind` do not establish
where source or prompts are sent. Unknown destinations require approval.

Do not add direct LiteLLM, OpenRouter or Anthropic connection fields, or a catalog
of named sub-agents. Assign work and frontier escalation to Poundlock execution
profiles from an approved pool. The loopback Project Manager exception above is
the only direct inference connection.
