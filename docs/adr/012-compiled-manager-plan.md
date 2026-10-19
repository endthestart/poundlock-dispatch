# ADR 012 — Compile semantic manager proposals into execution plans

Status: Accepted, 2026-09-14.

The Project Manager decides what work is needed: the plan summary, acceptance
criteria, task objectives, dependencies, difficulty and execution path. It does
not author filesystem permissions, working directories, dependency policy,
verification commands or model connection details.

Dispatch compiles that semantic proposal with the project's current settings.
The compiler supplies the attached project scope, project root, saved verification
defaults, effective permission mode and eligible execution profiles. It never
broadens permissions. Ignored files, secrets, paths outside the project,
system-level changes and unknown inference destinations keep their separate
controls.

When a project has no saved verification defaults, Dispatch discovers bounded
checks from files created in the repository after setup. The discovered checks
are saved as project defaults and shown with the active plan. A malformed or
partially written manifest yields no inferred command rather than stopping the
worker review.

A structurally invalid proposal returns one machine-readable
`plan_validation_failed` response with exact fields and allowed values. The same
manager receives one bounded repair attempt within the manager-turn budget.
Formatting and policy-shape failures do not justify frontier escalation. A second
invalid proposal stops visibly for user discussion.

A worker step becomes ready for manager review after its implementation attempt.
Only the manager accepts the step after inspecting its changed files and
verification evidence. Infrastructure and API failures use recovery handling;
they do not count as evidence that the model produced poor work.

The manager also hands each worker what it already knows, so the worker does not
search the code for it: a `contextNote` (background, sent up to 2,000 characters),
`filesToTouch` (project-relative paths or globs) and `reuse` (existing code to use,
each with its path). All three are optional and reach the worker labelled in its
brief, for interactive and durable tasks alike. The compiler refuses a path that is
absolute or leaves the project, and bounds the lists. Plans stored before these
fields existed carry none and brief the worker as they always did.

Amended by ADR 014: in a detached local auto run, the project's checks and the
plan's scope accept a case, labelled "verified, not reviewed". The manager stays
the only acceptor of interactive and durable work.
