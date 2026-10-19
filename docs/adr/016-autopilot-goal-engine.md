# ADR 016: Autopilot, one goal engine

Status: accepted for Phase 0, 14 Oct 2026. It supersedes ADR 014's B2 (checkpoint
supervision) and B3 (auto mode in the GUI). It amends ADR 001, 007 and 012 as noted at the
end.

## Context

The owner works like this:
1. Give the manager context and a role.
2. Let it interview until it understands.
3. Agree a spec.
4. Say "build it".

The manager should then keep working through workers until the spec is done. It stops only
when it can no longer work, is stuck in a loop, or reaches the goal's time or spend cap. The
owner can pause, talk, change the spec and continue at any time.

Dispatch has five ways to run work unattended, and none of them does this:

| Path | What it has | What it lacks |
|---|---|---|
| Interactive orchestrator (`core/orchestration.ts`, live folder) | Requirement ledger, mutation check, frozen tests, verifier, stuck briefs | Survives nothing. It is driven by manager turns and approval cards; in a 37-hour application build it stopped about 25 times. |
| Auto mode (ADR 014, `core/auto/`) | Detached runner, container, mirror and worktree, drafts, checkpoints, `finish_case` contract, 0 compactions in the A/B | A fixed case list, no manager, no ledger or gates, TUI only |
| Durable jobs (`implementViaDurable`) | Survives the app | A third worker loop, no resume, a 50 MiB upload, a fresh session per repair |
| `/unattended` grant | Pre-approval for 24 h | TUI only, and it routes work to durable jobs |
| Poundlock ACP adapter | Attached and delegated modes | Repeats Dispatch's two-path split |

Between them there are three worker contracts, three check runners and three state stores,
plus two data roots and two locks that do not see each other.

The September A/B showed two things:
- Robustness comes from an engine that owns its control flow.
- Quality is capped by the plan's acceptance tests and a reviewer stronger than the worker.

## Decision

**Autopilot is one goal engine that owns its control flow**, descended from `AutoRunEngine`.
The orchestrator becomes a planning and ledger service that the engine calls. In Autopilot:
- The manager does not review each task. Deterministic gates accept tasks, and the Planner
  judges milestones.
- Planner calls are fresh, bounded sessions with a packet: the spec, the ledger, milestone
  state, a diff summary and the verdicts.
- The long manager conversation is kept for the owner.

**The loop, for each milestone:**
1. **Plan:** the Planner plans the milestone's tasks. Each task cites requirements.
2. **Build:** each task goes attempt → gates → checkpoint commit. A failure gets a repair in
   the same session, or Planner triage when it is stuck.
3. **Verify:** the Planner checks the milestone against the ledger.
4. **Gap analysis:** spec against code.
5. **Checkpoint:** a notification, or a wait, as the goal is configured.

**Stops:** done, a cap, stuck, the owner, or infrastructure, and nothing else. New
authority parks only the task that needs it.

**The process.**
- There is one runner process per live goal. It is detached, survives quitting the app,
  and is the installed `dispatch` command run as `dispatch autopilot run <runDir>`.
- The packaged app keeps Electron's run-as-Node fuse off (L26), so the GUI spawns the
  command. Before spawning, the GUI checks that the command exists and that its version
  matches the app; if not, it offers `scripts/install-tui.sh`.
- Front ends read the project store and the run folder. Their only write is
  `inbox.jsonl`. The runner holds the project's `FolderLock` while it is live.
- Pause hands the project back to the attended UI. Continue respawns the runner, which
  replays its ledger.

**One of each, in place of the copies:**
- one data root, after a one-time copy of the terminal's projects;
- one lock;
- one run folder and ledger (`run.json` v2, `events.jsonl`, `status.json`, `inbox.jsonl`,
  `asks.json`, `report.md`);
- one worker contract, `finish_task`, taken from auto mode;
- one check runner, `runChecks` → `CheckRun`;
- one sandbox interface, `CommandSandbox`, generalized from `AutoIsolation`.

**Backends:**
- `ContainerSandbox` (colima `dispatch-auto`) is the default.
- `HostSandbox` (sandbox-exec) serves macOS-native projects, labelled reduced isolation.
- `MacVmSandbox` (Tart) follows if its spike passes.
- Autopilot does not use Poundlock durable jobs.

**Tiers:**
- *Local*: verification and gap analysis are advisory.
- *Frontier planning*: the Planner is a frontier profile; workers stay local.

A feature is enabled by the Planner's measured capability. The Planner is the `verifier`
role from 0.2.29, relabelled. Workers and their escalation rungs are always on the operator
network.

## Consequences

- Durable jobs stay for manual use (`dispatch jobs`). The manager stops routing tasks
  to them, and `implementViaDurable` is removed in Phase 5.
- `/unattended` is replaced by a goal grant, tied to the spec revision and the run.
- The attended orchestrator keeps working throughout the change. Feature work in it is frozen
  until Phase 5, apart from fixes.
- Linux containers cannot check macOS-native apps. Those run on the host sandbox until a
  macOS VM is proven.

## Amendments

- **ADR 001:** the manager still never writes the repository. In Autopilot it doesn't
  review each task either; the gates do.
- **ADR 007:** a third path, Autopilot, joins the live folder and durable job paths. Durable
  jobs are no longer chosen automatically.
- **ADR 012:** a compiled plan can belong to a spec milestone. Accepting it is done by gates,
  and judging it by the Planner.
- **ADR 014:** B1 stays the base. B2 and B3 are replaced by this ADR.

## As built (14 Oct, Phases 2–4)

The design held; these choices changed how it is built.

- **The engine was evolved, not replaced.** Auto mode's engine is the goal engine: its
  cases are the board's tasks, and tasks added to the board join between cases. A goal
  driver (`core/goal/driver.ts`) is asked whenever no task can run. It has the Planner
  plan the next milestone, or review the finished one and plan what closes its gaps. It
  ends the run when every milestone is verified, a checkpoint asks to wait, or gaps outlast
  the reviews.
- **The plan is the spec.** Milestones, an architecture and an out-of-scope list are
  optional parts of the plan, proposed through `propose_plan` and approved on the same
  card. The requirement ledger stays where it was. No second spec record or tool exists,
  and the manager's prompt budget holds.
- **The Planner** is a fresh read-only session for each call (read, grep, find, ls). It
  answers through one `submit` tool and is told exactly what to fix when an answer cannot
  be used. A bound Verifier plans and gates. Without one, the worker plans and only advises
  (the Local tier), and each milestone gets one review.
- **Greenfield goals** skip the base checks, since an empty repository has nothing to
  check. Every task is still accepted only on the checks.
- **Dependencies mid-run:** workers call `install_dependencies`, which runs the project's
  setup again in its networked throwaway container. Folders setup makes join the run's
  environment, and a new lockfile is part of the worker's change.
- **Front ends never write the ledger.** Stop, pause and owner messages go to the run's
  inbox. A message sent while Autopilot builds reaches the Planner at its next call and
  never starts a manager turn.
- **Taking the work** is the owner's step: an export, or a fast-forward merge that is
  refused unless the folder is clean and still at the run's base. Merged tasks read as
  done on the board.
- **The runner** is the installed `dispatch autopilot run`, started detached by either
  front end. The app checks that the installed command is the app's version.
- **Poundlock's queue** (contract revision 5) holds a request for a busy model in line
  instead of refusing it. Dispatch asks for owner priority for the manager's turns,
  planner priority for the Planner, and worker priority for workers.

## As built (Phase 5)

- **The attended orchestrator no longer uses durable jobs.** `implementViaDurable`, the
  manager's `durable` route, job submission, polling and reconciling, the source-upload
  consent, the review workspace's apply-back and Export patch are removed. Workers always
  run on this Mac. `dispatch jobs` and the Poundlock jobs client are unchanged.
- **Older projects** are brought up to date when Dispatch starts (`core/durable-retirement.ts`):
  a durable task becomes interactive, an attempt waiting on a job is closed as history, job
  bookkeeping and questions about jobs are dropped, and a job result that never reached the
  folder is named once in the conversation. Old attempts stay readable as history.
- **The walk-away grant and the Durable role are removed.** `/unattended`, `/attend`, the
  grant and the approval hook that read it are gone; Autopilot's start dialog carries its own
  consent. The attended manager-turn limit stays, as a plain per-plan number. The Durable role
  and job rungs in the model ladder are gone from Settings and the terminal. A saved grant,
  Durable role or job rung is dropped when it is read (`core/durable-retirement.ts`).
  `dispatch jobs` still picks its model directly.

