# Poundlock Dispatch requirements (v1)

Owner decisions, 2026-09-11. These supersede older TUI-first notes and the
snapshot-at-create flow. Implementation must match this file and the ADRs.
Poundlock remains the only inference endpoint the client uses. Optional GitHub
and Gitea tokens are for clone/push later, not for models.

Amended by [ADR 016](adr/016-autopilot-goal-engine.md): Dispatch no longer routes tasks
to durable Poundlock jobs. Where this file says the manager chooses durable execution,
requests an exact durable patch, or escalates to durable, read it as interactive only;
durable jobs are for manual use (`dispatch jobs`).

## Product shape

Poundlock Dispatch is a project-based desktop client of an existing Poundlock installation.
Users talk to one Project Manager per project. That agent plans, chooses an
execution path, delegates, reviews, and coordinates.

The Project Manager does not write the user’s repository. Local sub-agents write
project files through Pi and Poundlock **interactive** inference. Durable
Poundlock **jobs** are for long or isolated work. Both are features now.

Intended loop:

1. Connect once: URL, application token, **map execution roles**.
2. Add a project by choosing a local folder (path only) or a Git HTTPS URL
   with a branch or commit. GitHub/Gitea tokens are optional (Settings →
   Integrations).
3. Talk to the manager. It reads the folder, keeps private notes in Poundlock Dispatch’s
   data directory, and delegates.
4. Small work: local sub-agent + `/v1`. Large/long work: durable job.
5. Escalate on failure: snippet → interactive → durable → optional escalation
   pool. Never swap a model in the middle of an attempt.

## R1 — Connect, then path-only projects

App-level, once, **before the first project** (forced first-run wizard; later edits live in Settings):

- Poundlock URL and application token (**Test connection**). Role mapping is a
  separate step (**Continue** / **Save role map**). Do not combine them into one
  “Save and test” action after mapping.
- Map discovered profiles to Poundlock Dispatch roles (ADR 008). Manager and Interactive
  are required. Snippet, Durable, and Escalation may be blank. One profile may
  fill several roles. LiteLLM models appear only if Poundlock lists them as
  profiles. Poundlock Dispatch never takes a LiteLLM URL or token.

Each local project, required: a folder path. No file census, no inclusion
checkboxes, no 50 MiB warning at create. Walk the tree later with `.gitignore`
and default ignores. Git projects: HTTPS URL and a branch name or commit.
Optional Access uses a GitHub or Gitea account from Settings → Integrations.

The conversation is usable immediately after create. Sub-agents are roles and
tasks, not a marketplace to configure first.

## R2 — One controller; two APIs

Poundlock Dispatch uses **one** client URL for models and jobs: the Poundlock controller.

- Interactive / manager / snippet: `GET /v1/models`, `POST /v1/chat/completions`.
- Durable jobs: `GET /api/v1/job-options`, `POST /api/v1/jobs`, poll events.

LiteLLM and other providers are Poundlock endpoints. Distinguish example, draft,
and saved values. Failure copy must use Access labels where permissions are
involved. Empty Escalation must distinguish: missing `models:read`, no profiles
at all, versus profiles present but none published on a gateway. Do not treat
an operator “Test endpoint” success as a published catalog.

## R3 — Manager vs sub-agent vs job

Enforce with tools, not only a prompt.

- **Manager:** read the project (respecting ignores), read/write **only**
  Poundlock Dispatch’s per-project notes, list roles/profiles, propose a plan, ask the
  user, choose snippet / interactive / durable / escalation, request apply of an
  exact durable patch, request bounded repair. No shell, no repo write, no
  patch authoring.
- **Local sub-agent:** Pi on the user’s folder + interactive inference. Writes
  ADRs, specs, and ordinary project files in the repo.
- **Durable job:** isolated worker; snapshot assembled at submit time.

The manager always chooses the path. Independent work may run on different
Poundlock slots at once. Do not hold a manager `/v1` stream while a durable job
needs that same slot.

Approve, Start, durable-vs-wait, and local tool-trust modes (Ask / Approve for
me / Full access) are Poundlock Dispatch UI. The manager must not ask for those in chat.
Do not silently submit a durable snapshot for work routed interactive. Full
access never skips durable or off-box consent. Do not use a model as the
primary command-safety gate.

## R4 — Escalation

Use the mapped ladder. Tiny/snippet only for small completions the manager
cannot do locally. If a rung fails, a **new recorded attempt** on the next rung.
Escalation pool (LiteLLM / off-box) requires a mapped Escalation role or an
explicit user ask. Disclose when source will leave the machine.

## R5 — Lifecycle

Durable jobs continue if Poundlock Dispatch quits. Interactive turns do not. Planning
resumes when the app reopens. No hidden daemon. Removing a project must not
delete the original folder or unrelated Poundlock jobs.
