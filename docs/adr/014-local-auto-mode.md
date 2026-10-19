# ADR 014 — Local auto mode: an unattended runner for an approved plan

Status: Accepted for B1, 2026-09-29. Detached supervision only; checkpoint
supervision waits for later research. Written from the draft specification and a
comparison with a prompt-loop tool on long unattended runs (27 Sep 2026).

## Decision

The owner plans with the manager, then says "build this unattended". Dispatch
starts a visible runner process that works the approved plan case by case in a
private clone, and stops only at a limit, a block or the owner's request. Good
work is never thrown away. The result is a patch or a branch that the owner
reviews and applies; the runner never touches the owner's checkout.

- **Inference** goes through Poundlock's `/v1/chat/completions` with the
  project's worker profile, through the same provider, preflight and capacity
  paths as an interactive worker. There is no direct model endpoint. B1 accepts
  only a profile whose data destination is the operator network, with a context
  window of at least 128K (128,000 tokens).
- **Commands** run in a container (below). The Pi session, its file tools and
  Dispatch's own Git run on this computer.
- **The runner** is the terminal client's `auto run` subcommand, started
  detached by `auto start` or `/auto start`. It outlives the terminal. The TUI
  and `auto watch` attach to it by reading its files; leaving them detaches.

This is not a Poundlock durable job and not the interactive workflow run
headless. It amends ADR 001 and ADR 012 as noted at the end.

## Isolation: a container on the local VM, or no run

A run that nobody watches for twelve hours needs a boundary that holds when the
model's commands are wrong. `sandbox-exec` is not enough: it shares the user's
account, its profile has had gaps (the timezone database), and the A/B had to
drop to `full` trust, with no sandbox at all, because the sandbox also blocked
what the project's checks needed.

| Option | Verdict |
|---|---|
| **Container on the colima VM** (Docker CLI 29.7 and colima 0.10 are installed; VM type `vz`, virtiofs) | **Chosen for B1.** |
| Separate macOS user | Rejected. Setting it up is an administrator change to the machine (a user and a sudoers rule). It shares the kernel and has no network boundary of its own, so it still needs `sandbox-exec`. A user in `staff` can read everything the owner keeps world-readable, such as `~/Development`. Worktree sharing needs ACLs. |
| Each case as a Poundlock durable job | Rejected for local auto mode, kept for work that must not run here. It is strongly isolated, but the agent then runs in the hub's harness: none of the A/B fixes (the `finish_case` contract, nudges, time warnings and finalization, same-session repair) reach it. Every attempt uploads the source (50 MiB cap) and pays job start-up, and each repair is a new session. |
| A stricter Seatbelt profile | Still `sandbox-exec`. |
| Apple `container`, Lima, Tart | Not installed. Apple `container` (one VM per container) is the natural successor on macOS 26 and fits the same port. |

**What B1 does.** One container per run, from an image the owner names that
holds the project's toolchain. The image's ID is recorded in `run.json` when
the run starts, and every container is made from that ID with `--pull=never`,
so retagging the image mid-run changes nothing. It is started with no network,
all capabilities dropped, `no-new-privileges`, a process limit, a memory limit
of three quarters of the VM's memory (no swap beyond it) and the owner's uid.
Its mounts:
- the run's worktree, read-write, at the same path;
- the worktree's `.git` file, read-only, over the worktree mount, so the model
  cannot point it at a Git directory of its own;
- the mirror's `.git`, read-only, so Git works inside.

The container carries a label with a digest of these flags; a container made
with other flags, such as by an older Dispatch, is removed and made again rather
than reused.

Its entrypoint is Dispatch's own. Dispatch's host Git reads none of the owner's
global configuration, never signs, writes patches byte for byte, and never
stages or enters a Git repository nested in the worktree (that is a scope
violation).

The model's `bash` tool and every check run inside it through `docker exec`.
Nothing the model writes is executed on this computer:
- `run_command`, host `bash` and `git_inspect` are not registered;
- Dispatch's own Git on the worktree names its Git directory explicitly and
  disables hooks and fsmonitor, so a `.git` file the model rewrites is never
  followed.

Setup commands, such as `uv sync` or `npm ci`, run once in a throwaway container
before the base check. They get the network only when dependency downloads are
approved for the run. Dispatch never pulls or builds an image: if the runtime or
the image is missing, the run does not start. There is no fallback to the host.

**It protects:**
- the owner's files, credentials, SSH agent and other projects;
- the network during cases;
- host processes;
- runaway or leftover commands: every process in the container is killed
  when an attempt ends, before the checks and on stop, and the runner stops a
  run that is filling the disk;
- the owner's checkout. A wrecked clone is recoverable from drafts that the
  container cannot write.

**It does not protect:**
- the run's own clone;
- project source sent for inference (limited to an operator-network profile);
- a container or VM escape, which reaches only what the VM mounts (below);
- dependencies fetched during setup, which then run inside the container;
- the checks themselves: they run in the same container (killed and with /tmp
  cleared first), so their own files are fixed only if the plan protects them;
- checks that need the network, which fail until setup warms their caches. The
  separate "network for checks" setting stays an open proposal;
- projects whose checks need macOS, such as Xcode, which cannot run in auto
  mode.

**The VM mounts only the auto folder.** colima's default profile mounts the
whole home folder read-write, and its VM user has passwordless sudo, so one
container escape there reaches everything the owner has. Auto mode therefore
uses its own colima profile, whose only mount is Dispatch's auto folder, and
its Docker context `colima-dispatch-auto` is the default. The owner creates it
once (colima downloads a VM image; size it for the project's checks), then
builds or loads the toolchain image into that context:

```sh
mkdir -p ~/.poundlock-dispatch/auto
colima start --profile dispatch-auto --cpu 4 --memory 8 --mount ~/.poundlock-dispatch/auto:w
```

**Setup's network reaches the internet only (L29).** On colima a container on the VM's
bridge reaches services on the Mac, even ones bound to 127.0.0.1, through the VM's
gateway, and the owner's LAN. Before a setup step gets the network, a probe container
must fail to reach a listener on the Mac; otherwise the run is refused with the command
that applies Dispatch's VM firewall (`src/core/auto/vm-firewall.ts`):
`colima ssh --profile dispatch-auto -- sudo sh -c '…'`, which drops bridge traffic to
private, link-local and multicast ranges and lets containers reach the VM for DNS only.
The rules last until the VM restarts; to keep them, add the same commands as a
`mode: system` script under `provision:` in `~/.colima/dispatch-auto/colima.yaml`. A
networked setup also no longer mounts the mirror.

Every start and every runner start (so a resume too) checks this: a throwaway
container with no network bind-mounts the home folder read-only and lists it,
and the folders on the way down to the auto folder. Anything else it can see
refuses the run, naming what is visible and the command above; a runner that
finds it ends the run `blocked_for_input`. Refusing, not warning, because the
run is unattended for up to 96 hours and the container is its only boundary: a
warning printed once at start protects nothing. `--allow-home-in-vm` runs
anyway for one run; `run.json` records it with the context, and the start and
the runner log say so each time.

## Supervision

B1 is `detached`. A case is accepted on independent evidence only:
- every check exits 0 in the container;
- the change is within the plan's scope.

The worker's own claim never counts. Accepted work is a checkpoint commit
labelled **verified, not reviewed**, and the card, the status, the commits and
the export all say so. Four facts are recorded separately: preserved (a draft or
checkpoint exists), checks passed, reviewed (never, in B1), and accepted.

`checkpoint` supervision (B2) is out of scope. R6 has not run. The evidence so
far is against a same-model reviewer: in 6 blind-scored versions, it made code
worse as often as better, and once deleted the service. B2 starts only if R6
shows a stronger, plan-anchored reviewer improving versions without accepting
deletions. `full` is not built.

## How a case runs

1. **Attempt.** One Pi session per case, bounded by the case allowance. Repairs
   continue the same session with the failing output as findings. The worker's
   contract is in the system prompt, which compaction never summarises. It ends
   a case by calling `finish_case` (done, partial or blocked). After a compaction,
   a one-line reminder rides on the next tool result. A turn that ends without
   the call gets two nudges in the same session, with writes blocked.
2. **Draft.** Every attempt is saved before anything is reset: a commit under
   `refs/auto/<run>/drafts/…`, built through a throwaway index, plus a patch with
   its SHA-256. Resets happen only in the run's worktree, after the draft ref
   resolves.
3. **Verify and scope.** Checks run in the container. Scope uses the plan's
   writable, protected and bookkeeping paths. Files that run on the owner's
   machine once the patch is applied (Git hook managers, `.envrc`, editor,
   devcontainer and coding-agent settings, `AGENTS.md`) are out of scope unless
   the plan names them as writable; export lists them, and any `package.json`
   whose scripts changed, as files to review first. Tool caches (`__pycache__`,
   `.pytest_cache`, `node_modules/.cache` and the like) and paths created by
   setup are never violations and are never committed.
4. **Accept or repair.** "Done" with clean checks and scope makes a checkpoint.
   Verified work without a "done" is kept as a progress checkpoint. A later
   "done" with nothing new is accepted only if this run already checkpointed the
   case.

**Guards, each from an A/B lesson:**
- warnings at 80% of the allowance and at 5 minutes, then a 5-minute
  finalization window with writes blocked that can accept verified work;
- a command cap;
- a watchdog that counts Pi events and running tools as progress;
- a loop stop: at most 3 distinct calls in the last 40;
- a cycle nudge: a repeated call sequence of period 8 or less, with unchanged
  results, is blocked with "the results did not change";
- a command left running by an interrupted attempt is killed and recorded, and
  does not block the next attempt.

A run that ends at a limit with accepted work reports
`limit_reached_with_accepted_work`, never "failed". When Poundlock, the model or
the container runtime is unavailable, the attempt or its checks are retried
with back-off, and this does not count as a repair. If it persists, the run ends
`blocked_for_input`, ready to resume.

## Limits

These are the defaults, set per run and shown before the run starts. Time
limits count the time a run is worked: the pause of a stopped or interrupted
run is left out. A case already under way when a resumed run is past a soft
limit is finished first.

| Limit | Default |
|---|---|
| Wall clock | 12 h soft (no new case); hard at soft + one case + 15 min, capped at 96 h |
| Cases started | 40; skipped cases do not count |
| Per case | 60 min across its attempts |
| Repairs per case | 2, and 2 attempts failing the same way |
| Consecutive failed cases | 3; only a substantive acceptance resets the streak |
| No substantive progress | 4 h |
| Processed tokens | none. Input, output and cache writes count; cache reads never do |
| Shell command | 20 min |
| No progress from the model | 15 min |

## Lifecycle

- **Start.** Dispatch refuses to start unless every preflight check passes:
  - a saved connection;
  - a profile that is advertised, allowed, on the operator network and 128K or
    more;
  - Poundlock's access preflight for the profile;
  - free disk;
  - tracked changes committed;
  - checks and cases present;
  - the container runtime and image available;
  - a VM that shows nothing of the home folder but the auto folder;
  - the per-project lock.

  The runner then prepares the container and runs the plan's checks at the base
  commit. If they fail, the run ends `blocked_for_input` before any case starts.
- **One run per project.** A lock file exists while any run of that folder is
  unfinished. Within a run, a pid lock refuses a second runner.
- **Visible.** The run folder under Dispatch's data directory holds:
  - `run.json`;
  - the append-only, fsynced ledger (`events.jsonl`, the source of truth);
  - `status.json` with a heartbeat;
  - `runner.log`, drafts, check logs and sessions.

  The runner keeps the Mac awake while it works.
- **Stop.** SIGINT or `stop` stops after the case; SIGTERM or `stop --now` stops
  now and saves the attempt.
- **Resume.** After `kill -9`, resume:
  - replays the ledger;
  - records any checkpoint commit the ledger missed;
  - saves the interrupted attempt as a draft;
  - kills leftover commands;
  - continues the case in its session.

  Accepted cases are never redone.
- **Export.** A binary patch from the base to the last checkpoint, checked to
  apply to the base before it is written. It carries a header that says
  "verified, not reviewed". The branch `auto/<run>` can be fetched from the
  mirror. Nothing is pushed or applied automatically. The patch is never written
  inside the worktree.
- **The worktree after a run.** Everything in `runs/<run>/work` was written by
  the model. Its `.git` file is checked when a run ends and on export, and put
  back if it changed. Once a run can no longer resume (every case verified),
  export removes the worktree; the branch and the patch keep the work. Until
  then, never run Git in `work/` or open it in an editor that runs Git: a nested
  repository the model made there would run its own configuration.

## Amendments

- **ADR 001.** Running headless is now an explicit lifecycle, as above.
- **ADR 012.** The manager remains the only acceptor of interactive and durable
  work. In a detached auto run, checks and scope accept a case, and the result is
  labelled "verified, not reviewed" until the owner reviews the export.
- **`unattended.ts`.** Local shell stays out of unattended grants. Auto mode uses
  no grant and runs no host command.
- **`MAX_UNATTENDED_HOURS`.** It does not apply; auto runs have their own limits.
- **Shared model slot.** This warning belongs to B2, which adds a reviewer.
  During a B1 run, the interactive manager on the same slot queues behind the
  worker through Poundlock's capacity waits.

## Open

- A network setting for project checks, separate from the trust mode.
- After an abandoned case: skip dependents, or continue on the checkpoint.
- Marking truly independent cases in the plan, and a closing final-report case.
- External profiles, which need a consent design for unattended source egress.
- The GUI (B3): the runner already outlives the app.
