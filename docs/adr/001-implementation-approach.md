# ADR 001 — Poundlock Dispatch runtime with multiple interfaces

Status: Accepted; updated by owner direction on 2026-09-13. GUI first remains the
current MVP delivery choice. Shared-runtime extraction and other interfaces are
future work, not claims of completed portability or additional MVP acceptance gates.

## Decision

Poundlock Dispatch is the client product family: GUI, future CLI/TUI and editor
integrations such as VS Code. It depends on Poundlock for inference and durable
execution, including approved external models through published gateway profiles.
Users need one Poundlock connection, not separate provider credentials.

The current implementation uses Electron/React and hosts Pi SDK 0.86.1 manager and
worker sessions in the desktop process. Shared runtime code lives in `src/runtime`
(Pi sessions, Poundlock provider, policy extension, run_command, sandbox, journal)
and `src/core` (workflow, roles, environment). Electron adapters must not duplicate
the agent loop. Continue extracting before adding another interface: project state,
manager/worker lifecycle, policies, approvals, events, persistence and API
integration must keep working without Electron or React.
Adapters supply interface and host facilities; they do not duplicate orchestration.
Reuse the in-process Pi SDK and existing host facilities. A daemon, public listener,
new wire protocol or background orchestration service is not implied or required.

All interfaces preserve the strict workflow and permission boundary:
objective → manager plans/delegates → workers implement → results checked →
manager accepts, repairs or escalates. The manager cannot gain repository shell,
write/edit or patch-authoring tools through a CLI or full-access worker mode.

CLI supports structured results and noninteractive runs under explicit grants;
when required approval is absent, return a pending/blocked result rather than
silently consenting. TUI/GUI/editor adapters present the same approvals/events.
Persist one project/session identity and fence concurrent manager-turn owners.
Closing a view differs from exiting its host: attached work stops on host exit;
submitted durable jobs continue. Reopen observes until explicit resume. Running
headlessly in the background must be an explicit supported lifecycle.
ADR 014 defines the first one: the local auto-mode runner (pid, lock, log,
heartbeat, ledger; attach and detach from the terminal client).

## Delivery and compatibility

Finish the existing GUI MVP, then extract/test the shared runtime, then add CLI,
TUI and editor surfaces in complete separate slices. Verify cross-adapter state,
authorization, restart, cancellation and duplicate-dispatch protection.

Pi remains pinned at 0.86.1 for the current tested integration. The owner subsequently
approved the GUI rename in version 0.1.1: `Poundlock Dispatch.app`, package
`poundlock-dispatch-gui`, and app ID `app.poundlock.dispatch.gui`. First launch copies
legacy Lockkeep data into the new app directory while preserving the original.
Saved job keys, historical paths and the source checkout retain compatibility.
The current platform claims remain limited to actual acceptance evidence.

## Earlier implementation choice

Electron plus the in-process Pi SDK supplied the initial GUI with restricted
manager tools. OpenWork/OpenCode forks and alternative harnesses were not selected.
GUI-first was a delivery choice; it does not justify coupling reusable behavior to
desktop APIs. Manager/project state remains in Dispatch, not in Poundlock server.
