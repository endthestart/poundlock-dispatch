# ADR 002 — Client-owned orchestration, Poundlock-owned jobs

Status: Accepted, 2026-09-11.

## Decision

Poundlock Dispatch stores projects, conversation, plans, task graphs, budgets, and the
managed review workspace. Poundlock stores durable jobs, attempts, verification,
and runtime leases.

The manager proposes plans through tools. After the user approves and starts,
Poundlock Dispatch dispatches eligible worker jobs, polls for completion without running
the manager, then starts a bounded manager turn to review evidence. The manager
cannot submit arbitrary patches; it can only request that an exact worker patch
be applied, or request a bounded repair.

If Poundlock Dispatch quits, submitted Poundlock jobs continue. New planning and
delegation resume on reopen. There is no hidden daemon.

## Recovery

Each attempt has an idempotency key and a request hash. A lost acknowledgement
is retried with the same key. A 409 for a different body is surfaced as
uncertain and is not automatically resubmitted. Applied patch hashes are
recorded so a patch cannot be applied twice.

## Capacity

Manager turns and worker jobs are not overlapped. Waiting uses HTTP polling,
not an LLM loop, so a shared GPU can be used by workers.
