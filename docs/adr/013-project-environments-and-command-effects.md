# ADR 013 — Separate project environments from command authorization

Status: Accepted for 0.1.1.

## Decision

Dispatch treats toolchain selection and command authorization as separate
problems.

Project environments are selected from repository evidence. An environment
adapter prefers, in order: an existing project-local environment; the package
manager, lockfile, or toolchain declared by the repository; an installed
ecosystem tool that can create an isolated project environment; otherwise a
visible `environment_blocked` result. Dispatch does not silently install system
packages or substitute the system runtime for a configured project runtime.

Python with uv is the first setup adapter required by the 0.1.1 demonstration.
The adapter interface is intentionally reusable for Node package managers,
Cargo/Rust, Go, and other toolchains. Repositories that already provide those
tools can run them through the generic command boundary today; 0.1.1 does not
claim automatic setup support for every ecosystem.

Authorization depends on scope and effect, not on the language or framework.
Every structured command declares one of three intended effects:

- `inspect`: no intentional persistent project change;
- `project_change`: ordinary project-local creation or modification, including
  generated and dependency artifacts;
- `destructive`: discarding work, data, or history.

In Approve for me, `inspect` and `project_change` may run without another prompt
when Dispatch can confine the working directory and writes to the attached
project, deny protected secrets and unapproved network access, and use its
qualified operating-system sandbox. `destructive` asks for a decision. Outside
paths, privilege changes, unrestricted network, unapproved executables, and an
unavailable sandbox also ask or fail according to the hard boundary.

The worker's declaration is evidence, not sole enforcement. Dispatch retains
small ecosystem-neutral checks for obviously destructive primitives and may use
a separately qualified, bounded approval reviewer for ambiguous actions. It
must not grow a standing allowlist for each framework command. Unknown routine
commands stay constrained by the same sandbox and journal.

## Consequences

- `.venv/bin/python manage.py check`, `npm test`, `cargo test`, and `go test`
  are ordinary examples of the same policy, not separate permission rules.
- Adding an ecosystem means adding environment detection and preparation, not
  rewriting the authorization model.
- Project-local mutation is recoverable through the working tree, journal, and
  review evidence. Bulk deletion, database reset, and history rewrite remain
  explicit decisions even when their targets are inside the project.
- Platform releases must state whether a qualified sandbox and automatic
  environment adapter are available rather than silently weakening the policy.
