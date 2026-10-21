# Changelog

## 0.3.0 (20 October 2026)

The first public release, a developer preview. Autopilot is a preview. Tested with
Poundlock 0.3.0 (contract revision 5) and Toolkit 0.5.0.

- The manager and the Autopilot Planner can search the web and read public pages through
  your own SearXNG instance. Set its address in Settings → Connection → Web search, then turn
  on "Web search for the manager and Planner" in a project's Network settings. Queries that
  carry file paths, secrets, project names or pasted text are refused, pages come only from
  the public internet and respect robots.txt and rate limits, and every search is recorded
  (ADR 017).
- The connection test needs only **List available models** and **Send inference
  requests**; the job permissions are for the `dispatch jobs` commands, which say
  when they are missing. Labels say a token reads and cancels only its own jobs.
- The connection test refuses a controller that lacks the capabilities endpoint, serves
  another API major, publishes a contract older than revision 3 or lacks a required
  feature, and says what to upgrade to. `compat/poundlock.json` records the tested
  Poundlock release instead of a private build.
- Packages carry the full license texts for this platform's dependencies, the bundled
  fonts and the Catppuccin colours, and the app also carries Electron's own license and
  Chromium's notices. The app runs the Electron the lockfile selects (44.7.0); an old
  packaging override forced 44.3.0. `scripts/check-package.cjs` checks a built app.
- The terminal client and its installer require Node 22.19.0, as Pi 1.1.0 does.
- GitHub CI runs every check on pull requests, forks included; a tag attaches the tested
  packages to a draft release only after approval. `tests/e2e/run.mjs` runs Dispatch
  against a disposable Poundlock.
- Test fixtures that came from real runs are replaced with synthetic ones.
- Dispatch stays in the menu bar when you close its window, with a # icon that counts the
  Autopilot runs building and lists each with its progress; pick one to open its project.
  The Dock icon returns with the window. Quit from the menu bar menu or with Command-Q.
- Dispatch no longer runs tasks as Poundlock jobs. Workers always work in your folder on
  this Mac. The manager's plan has no durable route, "Implement as Poundlock jobs" and
  "Allow reviewed Poundlock job changes to be applied" are gone from Project settings, and
  so are the Background jobs model pickers, the source-upload approval, and Export patch.
  `dispatch jobs` for manual jobs is unchanged.
- A project saved by an earlier version is brought up to date when Dispatch starts: a task
  that was routed to a job runs on this Mac when you resume, an attempt waiting on a job is
  closed as history, and a job result that never reached your folder is named once in the
  conversation. Export it with the earlier version if you want it.
- The Background jobs model and job entries in the model ladder are gone from Settings and
  from `/role`, and so are the terminal's `/unattended` and `/attend`. Autopilot's start
  dialog carries its own consent. A saved Background jobs model, job entry or unattended
  grant is ignored. `dispatch jobs` picks its own model and works as before.

## 0.2.41 (October 2026)

- You can send a message while the manager is working; it opens the manager's next turn.
  Send used to stay disabled until the turn finished, which could take many minutes.
- Each new round of work starts with a fresh manager-turn allowance. A short round after a
  long one used to stop on its first turn.
- Reaching the manager-turn limit pauses the run ("Manager turn limit reached") instead of
  showing it as failed; Resume continues with a fresh allowance.

## 0.2.40 (October 2026)

- A task the manager delegates can cite the requirements it serves.

## 0.2.39 (October 2026)

- The manager can add an agreed new task to the board while another task runs (outside
  Ask mode). Replacing or changing published tasks still waits for the running work.
- A message you send while the manager is busy now opens its next turn, ahead of any
  review packet. Before, a review turn could clip it away and the manager never saw it.

## 0.2.38 (October 2026)

- When a check command crashes (signal 11 and the like), Dispatch adds the crashing
  thread from macOS's crash report to its output, so the worker and manager see where it
  crashed instead of guessing. Only reports that load code built in the project are read.
- A task out of fix rounds whose last attempt passed its checks offers accepting that
  attempt and moving the remaining work into its own task.

## 0.2.37 (October 2026)

- The manager sees the requirement ledger on every turn, beside the project brief, so it
  can cite requirement IDs after its conversation is compacted.
- Declining an escalation no longer pauses the project. Dispatch remembers the answer and
  the manager carries on another way; it used to sit paused until you pressed Resume.

## 0.2.36 (October 2026)

- A task out of fix rounds after a mutation check sent it back says which line no check
  caught, and offers accepting the attempt and planning the missing test, instead of
  "The attempt ended without a recorded error".

## 0.2.35 (October 2026)

- If Dispatch quits during a mutation check, it puts the changed line back the next time
  it starts, and says so in the conversation.

## 0.2.34 (October 2026)

- A process a worker's command left running after the command ended (such as a hung
  `swift test` helper after the worker's shell gave up on it) is ended when the next long
  command finishes and when the attempt ends. Worker commands carry a per-project marker in
  their environment to tell them apart.

## 0.2.33 (October 2026)

- The mutation check also runs for a project without saved checks, on the conventional
  ones Dispatch finds and runs.

## 0.2.32 (October 2026)

- A command that times out or is cancelled ends every process it started, including one
  that moved to its own process group: a hung `swift test` helper used to outlive the run.
- Workers run UI work in tests on the main thread (Swift Testing: `@MainActor`); off it,
  AppKit waits forever.
- The manager orders a new app's tasks so a user can walk a thin path end to end first,
  and the Verifier's plan review checks for it.

## 0.2.31 (October 2026)

- Swift packages build under "Approve for me". Swift Build links in a service that ignores
  the worker's temporary folder, so every sandboxed `swift build` failed at Ld with
  "permissionDenied"; the sandbox now allows only the folder it falls back to.

## 0.2.30 (October 2026)

- A mutation check before accepting an implementation task: Dispatch flips up to two
  conditions in the task's new code, reruns the project's checks and puts the code back. A
  break no check notices sends the result back once, naming the line; the task shows what
  was tried. Turn it off in Project settings → Execution and environment.

## 0.2.29 (October 2026)

- An optional Verifier role (Settings → Models → Verifier, or `/role verifier`). It reviews
  each new plan of three or more tasks against what you asked for before you approve it, and
  runs the round-end check of the requirement ledger. Bind your strongest model; unset, the
  Worker does the round-end check and plans go unreviewed.
- For an app with a user interface, the manager's implementation brief picks an
  architecture tests can drive without a person.
- Dispatch keeps a copy of each frozen test. When an attempt changes one, Dispatch puts it
  back, keeps the attempt's version under `.dispatch/frozen-edits/`, and asks for another
  attempt. Without Git, a worker had nothing to restore it from.

## 0.2.28 (October 2026)

- A task whose files include UI code asks its worker, in the task's own brief, for headless
  UI tests and off-screen snapshots of each changed view.
- The advice after an attempt runs out of time says to continue one-piece work with the same
  worker session rather than replace the task with an identical one.

## 0.2.27 (October 2026)

- An independent check at the end of each round: a read-only worker judges whether the code
  and tests show each requirement the round marked done, and names the test that would fail
  if a behaviour broke. Its verdicts go on the ledger and into the conversation, and "partly"
  or "not shown" blocks completion until new work or you settle it.
- A proposal whose task lists a frozen test among its files is refused while planning,
  unless the task is marked to change frozen tests.
- Removing a task hands its dependencies to the tasks that waited on it; approving such an
  update used to fail with "A task dependency does not exist".

## 0.2.26 (October 2026)

- Workers keep UI tests off your screen: no windows brought to the front, no alerts and no
  modal panels in tests, with errors routed where the test can read them. A test that
  still fails after two tries is reported instead of rerun.

## 0.2.25 (October 2026)

- Once a project has a requirement ledger, each implementation task in a proposal must
  cite the requirements it delivers, and unknown IDs are refused. Documentation-only
  tasks may cite none. Plan updates show changed citations.

## 0.2.24 (October 2026)

- UI snapshots as evidence. Workers are told to test app UI through its controllers and to
  render each changed view to `.dispatch/evidence/<view>.png`. Dispatch keeps those images
  with the attempt, tells the manager they exist, and shows them on the task, so you can
  see what changed without running the app. `.dispatch/` is left out of change tracking.

## 0.2.23 (October 2026)

From a retrospective of a long unattended application build:

- **Requirement ledger.** The manager lists your requirements, each with scenarios a user
  carries out to show it works. Tasks cite the requirements they serve, and workers see
  them. The plan card shows each requirement's status and anything with no task yet. The
  manager cannot mark the project complete while a requirement is open; only your own
  words drop one.
- **Rounds keep going.** Design questions come in one batch before planning. Questions that
  need not stop the work are noted and raised when a round ends. In a mode that approves
  within permissions, the next round for open requirements starts without an Approve
  click if it asks for no new authority.
- **Plan updates show what they change.** The card lists the tasks an update adds, removes
  and rewrites, with the fields. A restatement with placeholder text keeps the task's own
  specification, and a new task needs a real one. A local manager had rewritten fifteen
  task specs to "placeholder".
- The manager gets a note when a task's acceptance criteria only name files, builds or test
  counts.

## 0.2.22 (October 2026)

- Compacting the manager's conversation works on long runs. The summary request sent the
  whole stored history, which on a long run exceeded the model's context; it now gets
  the history as turns send it, cut to fit.
- The completion review sends one line of checks per task instead of every check's
  full output, which on a long project ran to hundreds of thousands of characters.

## 0.2.21 (October 2026)

- Answering a question the manager asked during an approved run lets the run go on. It
  stayed paused until a separate Resume after every answer.

## 0.2.20 (October 2026)

- Build output is never frozen as a test, and any recorded before is ignored and dropped.
  A Swift test task had frozen SwiftPM's `test_entry_point.o`, so every later build looked
  like a changed test.

## 0.2.19 (October 2026)

- Reviews say when a passing check ran no tests, and a test task in that state is sent
  back. A Swift shell's `swift test` passed with no tests found.

## 0.2.18 (October 2026)

- An escalation you declined is not offered or requested again in that run, until you
  mention escalation in a message. A local manager asked for the same declined Mac Pro
  escalation on two tasks within an hour.

## 0.2.17 (October 2026)

- SwiftPM's `.build` folder is left out of change tracking, reviews and uploads, as
  `target` is for Rust. A first Swift build counted 2,618 artifacts as changed files.

## 0.2.16 (October 2026)

- Swift packages build and test inside Dispatch's sandbox. SwiftPM and the compiler each
  start a sandbox of their own, which macOS refuses inside another, so Dispatch turns
  theirs off; `swift build` and `swift test` are discovered as checks beside a
  `Package.swift`, and compiler caches go to the worker's temp folder.

## 0.2.15 (October 2026)

- A board update that restates a task without its test flags or files keeps the task's
  own. A restated board had dropped `writesTests` from every test task.

## 0.2.14 (October 2026)

- A repaired task's brief carries only the latest review's findings. Earlier rounds piled
  up, so a fresh worker was asked to redo work long done.
- A stuck task's reason names the failing tests instead of the first lines of the check,
  which for cargo were warnings.

## 0.2.13 (October 2026)

- A repair or delegated task whose brief names a frozen test is returned to the manager
  once, before a worker spends an attempt on a change acceptance would refuse. It says to
  plan a `changesFrozenTests` task when the test has to change; asking again proceeds.

## 0.2.12 (October 2026)

- Tests written before their code assert the finished behaviour: test workers are told not
  to expect the code to be missing, and a test task whose checks pass is reviewed for tests
  that would. Frozen, such a test could only fail once its code existed.

## 0.2.11 (October 2026)

- Raw Bash commands stop after ten minutes, as `run_command` does. A worker's debugger run
  on a hung binary used 23 minutes of a 45-minute attempt.
- A task whose attempt runs out of time gets one suggestion to split what is left, as an
  oversized task does; asking again continues it.

## 0.2.10 (October 2026)

- A worker whose tool call is refused, such as a write outside the project, reads the
  error and carries on; only your refusal stops it. Every refusal used to end the turn and
  cost the attempt.
- Checks run with a temp folder named the way a terminal names it, so tests that trip
  over macOS's `/var` link fail under Dispatch as they would for you.
- The manager is sent earlier turns' file reads as one line each. They were three
  quarters of a 118K-token manager context.
- A stuck task offers Retry task and no Override; Override says it only records a note. A
  question the manager repeats before you reply shows once.

## 0.2.9 (October 2026)

- During a run, a manager's plan update adds or changes the tasks it names and keeps the
  rest; removing a task takes naming it in `removeTasks`. New tasks are placed before the
  task that depends on them. A local manager asked to restate a fifteen-task board kept
  proposing only the two tasks it changed.
- Reviews of tests-first tasks reject a failure in the test's own setup, which a frozen
  test could never get past.

## 0.2.8 (October 2026)

- Reviews name the failing tests: the check summary carries failing test names, panics,
  assertion values and compiler errors instead of the first lines of output, which for
  cargo were compile progress.

## 0.2.7 (October 2026)

- Resume also continues a run stopped at the manager-turn cap before 0.2.6.

## 0.2.6 (October 2026)

- Long plans can finish: a run's manager-turn allowance scales with the plan (4 per task,
  at least 24), approving a plan gives a fresh allowance, and Resume continues a run that
  reached the cap instead of requiring a new run.
- A board update that would drop published tasks says so, to the manager and on the plan
  card, before you approve it.

## 0.2.5 (October 2026)

- Frozen tests are enforced where workers write: the file tools refuse them and the
  command sandbox cannot change them, while they stay readable and runnable. Before, a
  worker could edit one and then had no way to restore it exactly.
- Tests-first tasks put any stubs for code that does not exist yet in the source files,
  never in the tests; workers are told which test files are frozen.

## 0.2.4 (October 2026)

- Tests-first tasks can finish: their new tests fail until the implementation task, so
  Dispatch now accepts a test task whose checks ran and failed (not for an environment
  reason) once it has changed test files. The tests are frozen, the implementation task
  must make them pass, and a durable test job runs with no in-job repairs.

## 0.2.3 (October 2026)

- Rust projects work: worker commands run with a private HOME, so rustup could not find
  the installed toolchains ("no default is configured"). Workers now get `RUSTUP_HOME`
  pointing at your toolchains; caches and downloads stay private.
- A toolchain that cannot be selected counts as an environment problem, so it no longer
  spends fix rounds or shows as a work-quality failure.

## 0.2.2 (October 2026)

- **Managed work.** The manager is told it manages: it splits work into tasks a worker can
  finish in one attempt and names each task's files.
  - Tasks marked large, naming no files, or past about five files of new logic get a
    non-blocking note when proposed; an oversized task that fails gets one suggestion to
    split before a fix round is spent.
  - Fix rounds per task are set in Settings and can be overridden per project (0–5).
  - An attempt with nothing to review (such as an incomplete model response) spends no fix
    round; three in a row pause the run for you.
  - Tests first: a task marked `writesTests` freezes its test files once accepted. A later
    attempt that changes one cannot be accepted, durable jobs get them as protected paths,
    and changing one on purpose takes a task marked `changesFrozenTests`, shown on the plan
    card with its files.
- A review that ends without a decision gets one reminder before the run waits for you.
- A manager whose model route changed in Poundlock now says to approve the route in
  Settings, instead of asking for another message.
- Fixed: the manager could not call the folder request; a folder card asking for read no
  longer offers read and write.
- A new project's name follows the chosen folder until you type one (it used to keep
  the name of the folder chosen first).


## 0.2.1 (October 2026)

- Pi 1.1.0.
- `dispatch jobs submit --help` explains how `--max-repairs` splits the job's output budget.
- Manager questions are cleaner. The manager can offer two to four answers, shown as
  buttons on the question card; you can still reply in your own words. A message's tool
  steps are collapsed under "N steps", "Reasoning: none" is no longer shown, and the
  stale "Finishing this manager turn…" line is gone.
- Other folders: Project settings can add a folder outside the project, read-only or
  read-and-write, through the folder picker. The manager can ask for one with a reason;
  you allow it read-only, allow read and write, or refuse on a card, and the manager
  continues with your answer. Background jobs still never receive extra folders.
- Dispatch's own decisions (such as running tasks as background jobs) now show their
  buttons in the GUI's decision panel.
- Electron 44.7.0, with backported Chromium and V8 security fixes.
- Build-time dependencies: source-map-js 1.2.2 and http-cache-semantics 4.3.0. sprintf-js
  (through electron-builder's Electron download) has no fix; its exception expires 21 Nov.
- CI scanners: osv-scanner 2.7.0 and Semgrep 1.180.0; refreshed base image.
## 0.2.0 (October 2026)

The first release for daily use. Tested with Poundlock 0.2.0.

### Added

- **Network switches per project.** **Internet** (on by default) and **Local network**
  (off) decide what every command a worker runs may reach, in every permission mode:
  Project settings → Network, or `/network` in the terminal. Commands no longer ask about
  the network one at a time. Raw Bash in Ask and Full access is held to the switches
  too. This Mac's own services count as the local network
  ([ADR 015](docs/adr/015-project-network-switches.md)).
- **The `dispatch` command.** `scripts/install-tui.sh` installs the terminal client
  with its own dependencies and a `--rollback`; `dispatch --version` and `--help`.
- [Install guide](docs/INSTALL.md) and [user guide](docs/USER-GUIDE.md).

### Changed

- Pi 1.0.3, which also fixes the vulnerable brace-expansion Pi 1.0.0 pinned.
- Package installs need the project's Internet switch on, not the plan's say-so; the
  plan still says whether the work installs anything. Background jobs ask Poundlock
  for outbound access when Internet is on.
- Remembered command approvals no longer include the network, so each is asked once
  more after upgrading.
- Changing a project's network or permissions applies from the next command instead of
  pausing the run.

### Security

- Auto mode gives setup the network only on a VM whose containers cannot reach this
  Mac or the owner's network; otherwise it refuses and prints the VM firewall command
  (L29). A networked setup no longer mounts the run's mirror.

### Fixed

- The auto-mode VM command quotes its folder, which has a space on macOS.
- The auto-mode start message prints its limits as hours and minutes.

## 0.1.3 (5 October 2026)

Pi 1.0.0. Auto mode (ADR 014) and the edit guard. Sandboxed installs reach only
package registries through a local proxy; the sandbox allows only named macOS
services; a remembered command lapses when the files that decide what it runs change.
Fixes from the 30 September security review and the 0.1.3 release review.

## 0.1.2

Durable checks use the image's uv and CPython 3.14. Contract revision 3 or newer.

## 0.1.1

The first internal release: the desktop app, Project Manager and Pi workers, durable
jobs through Poundlock, contract revision 2.
