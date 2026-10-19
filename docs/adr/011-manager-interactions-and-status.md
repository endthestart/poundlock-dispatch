# ADR 011 — Manager interactions, visible status, and frontier order

Status: Accepted by the owner, 2026-09-13. Implementation is a manual-test candidate.

The manager answers ordinary questions without forcing a plan. An agreed small
deliverable can be delegated to a worker under existing tool permissions; the
manager never receives repository shell, write or patch-authoring tools. Larger
implementation requests receive a plan. **Approve and start** approves the shown
scope and immediately attempts execution; additional required authorization remains
visible. No separate Start step is required for a new approval.

Before a substantial plan, the manager treats requirements discovery as a
conversation rather than a fixed form or framework-specific checklist. It inspects
the smallest relevant project context, measures the request against decisions that
materially affect behavior, architecture, data, acceptance, or authority, and asks
one focused question at a time only while those decisions remain unresolved. It
honors a user-supplied question limit and keeps answers in private manager notes.
A detailed specification skips discovery. A later instruction such as "build it"
uses the specification already established in conversation, notes, or project
documents instead of restarting intake.

Questions are selected from the objective rather than a technology catalog. For an
underspecified product, intended users, core workflows, persistent data, compatibility,
and first-release boundaries may be material. A language, framework, or version is
asked about only when the choice changes compatibility or acceptance. Routine choices
already delegated to the manager do not consume a question. This keeps the same
contract useful across Python, JavaScript, Rust, Go, and non-code projects.
For example, a bare request to build a Django task manager may require decisions about
single-user versus multi-user behavior and the task state model. The Django version is
a manager choice unless deployment or compatibility constraints make it a product
decision.

Worker results return to the same manager lifecycle. The manager may clarify a
worker's findings, issue a bounded repair with better instructions, coordinate a
dependent task, or ask the user for a decision that cannot safely be inferred. This
interaction is driven by the objective and evidence; the Django demonstration is
an acceptance scenario, not a built-in project template.

Accepted scope is continuing authority for ordinary coordination. When verification
or review identifies an implementation defect and the specification determines the
correction, the manager requests the bounded repair or advances dependent work without
asking the user to restate the goal. New product scope, destructive recovery, external
data movement, or an unresolved product decision remains visible to the user.

The left column owns projects, navigation, concise attention indicators and
Settings. The center column owns the manager conversation, every required decision
(manager questions, plan approval, action approvals, recovery and run actions) and
the composer; each decision has exactly one actionable home there. The right column
owns the approved plan and revision, task progress with read-only acceptance
checkmarks, and per-task evidence; it shows no run controls or duplicate status
summary. Infrequent project actions (new conversation, new run, history, settings,
export, archive, remove) live in one labeled Project menu that shows only actions
valid for the current state. (Amended 2026-09-18 for the 0.1.2 layout; this
replaces the earlier placement of approval and run actions in the right panel.) History is timestamped; persisted historical prose is not treated
as proof of current runtime capabilities. Obsolete local-worker decisions are
reconciled on reopen without resuming work or selecting a durable override.

Actions acknowledge receipt while processing and then show the resulting state.
Wait pauses new work while retaining the proposal and allowing discussion. Already
submitted durable jobs may finish. Resume is explicit. Cancel ends the current run,
not the project or its conversation. Replacement plans preserve the previous plan
and attempts in the local project history; uncertain remote work must be reconciled
before a replacement run can be created.

## Escalation ownership

The manager assesses results, considers corrected instructions and bounded repairs,
and requests capability escalation with evidence. Workers cannot select frontier
models independently. Dispatch enforces the ordered profile list, current
connection/plan authorization, eligible execution path, and run/repair limits.
Poundlock continues to own published profiles, admission, runtime preparation and
execution. No new server workflow or direct LiteLLM connection is introduced.

The list is expandable and reorderable. Manager and interactive workers use its
interactive entries; durable workers use eligible job entries. Missing or
unusable profiles are reported, not silently skipped. Busy/sleeping nodes and
operational failures are recovery conditions, not capability-escalation triggers.
A manager handoff begins a new turn with restricted tools and recent project
context. Worker escalation starts a new repair attempt after terminal reconciliation.
Prompt revisions and reasons are retained; tools from a partial attempt are not
blindly replayed.

Ask mode obtains a decision for each escalation transition. Standing authorization
explicitly permits listed profiles and their declared destinations to receive
selected project context across projects on that connection. Unknown destinations
still require a decision. This grant does not broaden tool/file scope or authorize
a durable snapshot. Saved transition grants are invalidated by changes to the
controller, token, profile preferences, escalation policy, or plan revision.

The transition limit is shared by manager and workers per plan; existing manager,
worker-attempt and repair limits remain in force. Model judgments about capability
are explanations, not deterministic diagnoses or proof of model quality.

## Budget limitation

Standing authorization is implemented as explicit authority with bounded attempts.
Dispatch does not currently retrieve or verify gateway balances or enforce a
monetary ceiling. The UI says so. Users may configure upstream LiteLLM limits, but
Dispatch does not certify those limits. Budget-aware automatic admission remains
deferred until an authoritative service contract exists, as specified by ADR 006.
