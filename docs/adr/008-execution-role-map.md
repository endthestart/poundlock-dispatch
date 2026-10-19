# ADR 008 — Explicit role bindings and qualified profile pools

Status: Accepted; reconciled with owner direction and ADR 006 on 2026-09-13.

## Current MVP

The Connect role map provides explicit user-confirmed bindings to published
Poundlock profiles. Preserve saved bindings and canonical profile IDs/aliases;
the same profile may fill multiple roles without creating capacity.

| Role | Purpose |
|---|---|
| Manager | Restricted planning/delegation/review through `/v1`. |
| Interactive | Attached worker inference through `/v1`; tools run on the client. |
| Durable | Removed by ADR 016. Jobs are for manual use (`dispatch jobs`); no role binds them. |
| Snippet (optional) | Qualified FIM/completion workflow. |
| Escalation (optional) | Explicit alternative capability selected under policy; not necessarily external. |

Names, aliases and gateway type cannot establish location, quality, permissions or
escalation suitability. Workload class can constrain compatible execution paths;
it is not a universal capability ranking. Destination comes from explicit declared
metadata/authorized policy; unknown is preserved. External does not imply stronger.

## Forward direction

Operators can provide qualified pools, role defaults and policy so employees need
not choose models for every question or understand GPU topology. Dispatch filters
hard constraints; the manager selects and explains an eligible profile for the
task. Explicit pins/overrides remain possible within authority. Capability tier,
execution path, role and destination remain independent, per ADR 006.

The current manual map remains supported during that evolution. This document does
not claim automatic pool routing, hardware/performance discovery or organization
policy enforcement has shipped, or require it for current GUI acceptance.
