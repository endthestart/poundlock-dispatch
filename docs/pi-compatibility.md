# Pi compatibility

Poundlock Dispatch embeds `@earendil-works/pi-coding-agent` **0.86.1**. A Pi fork is not required.

## Ownership

- Pi owns the agent loop, JSONL sessions, built-in file tools, cancellation, compaction, and stream events.
- Dispatch owns plans, tasks, attempts, permissions, role routing, environment setup, and the GUI.
- Poundlock owns catalogs, destination/route metadata, access preflight, capacity, and durable jobs.

Dispatch disables Pi's managed `rg` and `fd` downloads. Pi's grep and find tools
use an already installed binary found through the application's bounded tool
path; an unavailable helper produces a tool error instead of making an implicit
network request. Structured command output is streamed through Pi while the
Dispatch host executor retains the bounded final output and journal state.

Pi conversation IDs are not workflow IDs. Restoring a Pi session continues chat only. Dispatch will not dispatch or accept work unless `dispatchAuthorized` is set after plan approval or an explicit resume.

## Compaction

Dispatch makes Pi's compaction visible and lets the owner start it. It uses
`session.compact(instructions)` for a manual one, the `compaction_end` event for
the ones Pi runs on its own (the numbers come from its `result`), the
`session_before_compact` hook for how many messages the summary replaces, and
`session.getContextUsage()` for how full the context is. Pi refuses a manual
compaction in prose only: "Nothing to compact (session too small)" and "Already
compacted". Dispatch matches those two phrases, so a Pi upgrade must recheck
`tests/pi-manager-compaction.test.ts`, which drives them against the real
session. The manager's summary requests and a worker's pass through the
Poundlock stream like any other request. The project brief is in the system
prompt of every turn, which compaction never summarises.

## Edit guard

Workers keep Pi's `edit` tool; `src/runtime/edit-guard.ts` rewrites some of its
results. It notes when a file changed on disk since the model last read or wrote
it through Pi's tools, says "already applied" instead of "not found" or "no
changes made", shows the closest region of the file on a miss, and after three
failed edits in a row on one file blocks edits to it until it is read. It
recognises Pi's errors by their opening words (`Could not find the exact text
in`, `Could not find edits[i] in`, `No changes made to`).
`tests/edit-guard-replay.test.ts` replays recorded lab failures and checks that
Pi still gives those messages, so an upgrade that rewords them fails there.
The guard's counts go into each interactive attempt's provenance as `editGuard`;
`scripts/edit-failures.ts` counts failed edits in worker sessions, with or
without the guard.

## Contract suite

`tests/pi-contract.test.ts` covers:

- the pinned Pi version matches `PI_VERSION`, which job provenance reports
- persistent session create/restore
- built-in tool working-directory behavior
- `tool_call` blocking before execution
- terminating structured tools
- dynamic provider registration
- app-owned extensions with untrusted project resources
- built-in tools reach Poundlock without strict schemas (Pi 0.86 enables them by default; local models then fill every optional argument)

Pi 0.86.1 does not flush a new JSONL session to disk until an assistant message exists. The contract suite restores from that flushed file. Restoring a conversation never dispatches work.
