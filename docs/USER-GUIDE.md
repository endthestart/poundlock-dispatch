# Using Poundlock Dispatch

Dispatch is a project manager and a team of coding workers that run on your own
models through Poundlock. You describe the work; the **Manager** plans it and
reviews the result; **workers** write the code in your project folder. Nothing is
committed or pushed for you.

The desktop app and the `dispatch` terminal client do the same work and share the
projects and their history, the connection, model choices and permission defaults: a
folder opened in one appears in the other.

## Start a project

- **Desktop:** **+** next to Projects, then **Folder on this Mac** or **Git
  repository** (an HTTPS URL and a branch or commit).
- **Terminal:** run `dispatch` in the folder, or `dispatch path/to/folder`. A Git
  repository is `dispatch --git <https url> --branch <name or commit>`.

A folder project works in the folder itself. Ignored files and common secret files
(`.env`, keys, credential files) stay out of the workers' reach unless you grant a
single file in Project settings.

## Work with the Manager

Talk to the Manager as you would to a colleague. A vague idea gets one focused
question at a time; a clear specification goes straight to a plan. A proposed plan
shows its tasks, the checks that will decide success, what it may install, and how
each task runs. Nothing starts until you choose **Approve and start** (`/approve`).

While a run works, the status line says what is happening. **Pause** stops after the
current step, **Resume** continues, and **Cancel** ends the run (`/pause`, `/resume`,
`/cancel`). A task that stops for a reason you can fix says what that reason is; give
it more room with `/retry`, or continue past a stop with `/override`.

Each task's result is checked by running the project's checks, and the Manager reviews
the change before accepting it. A worker saying "done" is never enough.

The **Transcript** chip beside the composer sets how much of the work the conversation
shows. **Normal** folds each reply's tool steps and keeps one update between messages;
**Verbose** opens every step and update.

**Project → New conversation** gives the Manager a fresh start and moves the old
conversation to History. **Project → Start a new run** keeps the conversation and
clears the plan.

## Permissions

How much a worker may do on your Mac without asking, per project or as the default
(Settings → Permissions, the composer chip, or `/trust`):

| Mode | What it means |
|---|---|
| Ask for approval | A card asks before every shell command and anything destructive. Ordinary edits inside the project do not wait. |
| Approve for me | Edits, setup, tests and builds run inside macOS's sandbox without asking; anything the sandbox cannot hold asks you. Raw Bash is off. |
| Full access | Commands run with your account's authority. Use it for projects you trust. |

An approval card offers **Allow once**, a remember button (for example **Allow this
action for this plan**) and **Deny**. Remembered approvals are kept per project and
lapse when the files that decide what a command runs change.

External models always ask separately, even in Full access.

## Network

Every project has two switches, in Project settings → **Network** or with `/network`:

| Switch | Default | Lets commands reach |
|---|---|---|
| **Internet** | on | public addresses: package registries, documentation, APIs |
| **Local network** | off | this Mac's own services (`localhost`) and your network's devices, such as a router or Home Assistant |

They decide what every command a worker runs can connect to, whatever the permission
mode, and a change applies from the next command. Turn Local network on for a project
whose tests start a server on `localhost`. With only one switch on, programs reach the
network through a small proxy that most developer tools use on their own; SSH and other
raw connections need both switches on. Package installs need Internet on. In Ask and
Full access the switches hold the network only; everything else a command can do is
what the mode allows.

## Poundlock jobs

Dispatch never runs a task as a Poundlock job: workers always work in your folder on
this Mac. `dispatch jobs submit` sends a folder to Poundlock as a sealed job by hand,
and `dispatch jobs patch` fetches what it changed. A project from an older version
that ran jobs on its own is brought up to date when Dispatch starts: its tasks run on
this Mac, and a job result that never reached your folder is named once in the
conversation.

## Models

Settings → Models and routing chooses the profiles Poundlock serves for each role:
**Manager**, **Worker**, and optionally **Autocomplete**
(`/models`, `/role` in the terminal). A project can override them. The **Model ladder**
lets a stuck task move up to a stronger model. When Poundlock starts serving a model
differently, Dispatch asks you to approve the new route once (`/approve-models`).

## Context

A model's memory of the conversation is finite. When it fills, Pi summarises the older
part and keeps the recent messages, and the conversation shows a notice saying so. The
conversation you read is never changed. **Project → Compact conversation** or
`/compact` does it now; the context chip next to Send shows how full it is.

## The terminal client

`dispatch` in a folder opens it. The first time, it asks for the controller address and
token, then for a manager and a worker model; `/role` saves the two together. Type `/` to
complete a command, or `/help` to list them all. The ones you will use most:

| Command | Does |
|---|---|
| `/approve` | Approve the proposed plan and start. |
| `/board` | The plan and its tasks. Tab switches between them and the conversation. |
| `/pause`, `/resume`, `/cancel` | Control the run. |
| `/trust`, `/network` | This project's permissions and network. |
| `/models`, `/role` | What Poundlock serves, and which model is the manager or the worker. |
| `/compact` | Summarise older context now. |
| `/autopilot` | Build the approved plan unattended ([Autopilot](#autopilot)). |
| `/connect`, `/setup` | The controller and token; what is configured. |
| `/quit` | Exit. |

`dispatch jobs …` drives Poundlock jobs by hand from a shell, and `dispatch autopilot …` runs
Autopilot. Each has `--help`. `dispatch --json` prints the project's state and exits, for
scripts.

## Autopilot

Autopilot builds an approved plan unattended, for hours, in a private copy of the
folder. Every command runs in a container on a dedicated VM
([install](INSTALL.md#autopilots-vm-optional)). A task is accepted only when the
plan's checks pass and its changes stay inside the plan's scope: that is **verified**.
Then the Planner reads the code and its tests and gives each requirement a verdict:
**shown**, **partly** or **not shown**. A run keeps going when you quit the app or the
terminal, and survives a crash or a reboot.

**Desktop:** a folder project with a plan offers **Build with Autopilot…**.
- Choose the toolchain image, a time limit and any setup commands.
- Confirm the checks: the manager suggests them with the plan, and they become the
  project's checks.
- A Planner outside your network needs your consent and a spend cap.
- A plan still waiting for approval is approved and built in one step.

The run card shows how it stands, time and Planner spend against their limits, what the
manager and the Planner cost across all projects in the last 7 days, a chip per
requirement (green shown, amber partly, red not shown, grey not reviewed yet), what it
is doing now, and once it ends, what needs you and what was built. Run ids, checkpoints
and the container are under **Details**. With desktop notifications on, you get one
alert when a run stops building.

| The card says | What to do |
|---|---|
| Building | Nothing. **Message Autopilot** to tell it something; **Stop after this task** or **Stop now** if you must |
| Paused | Its runner stopped (a quit app, a reboot): **Resume** |
| Needs you | Read **Needs you**; answer in the conversation, then **Resume** |
| Built, *n* gaps | Read the red and amber chips; **Build again…** to close them, or merge what is verified |
| Built, not reviewed | Every task passed its checks but no Planner judged the requirements: read the work before you rely on it |
| Built | **Merge into folder…** fast-forwards your branch to the last verified commit |
| Stopped, Nothing verified | Read the report (**Open report**), then decide |

**Message Autopilot**, or anything you type while a run builds, goes to the run: the
worker on the current task hears it before its next step, and every later task and the
Planner's next milestone plan or review read it. To change the plan itself, stop the run
and talk to the manager.

If a run stops before it starts because a container could reach this Mac, apply the VM
firewall command the message gives, then start again. **Export patch…** saves the
verified work as a patch. The app runs Autopilot through the `dispatch` command, which
must be installed from the same release.

**Terminal:** `/autopilot` works the open folder and shows a card while the run works.
From a shell:

```sh
dispatch autopilot start --dir . --image python:3.14-slim --plan plan.json
dispatch autopilot watch            # Ctrl+C leaves it running
dispatch autopilot message --text "Keep the database code in src/lib/server."
dispatch autopilot stop [--now]
dispatch autopilot resume
dispatch autopilot export --out run.patch
```

Without a run id they act on the newest run of `--dir`, or of the folder you are in.
`dispatch autopilot --help` lists
the options and limits; `resume` picks a run up where it stopped. Read the exported patch or the merged commits before you build on them.
`dispatch auto` and `/auto` still work for one more release.

## Building a product on your own

The order that works, learned from the benchmark runs.

**Once:**
- In Settings → Models and routing, choose a Manager and a Planner with a long output limit,
  a Worker, and a local fallback for each cloud role. A provider that refuses for money
  moves that role to its fallback, and the card says so.
- Autopilot caps the Planner's spend per run. Set any total limit with your provider
  itself; the card's **Last 7 days** shows what the Manager and the Planner cost.
- Install Autopilot's VM with its firewall, and a container image with the project's
  toolchain.
- Turn on desktop notifications, so a run that stops building reaches you.
- Where the product depends on outside facts (formulas, file formats, an API, a standard),
  turn on the project's **Web search for the manager and Planner**. The Planner then reads
  the sources and saves excerpts for the workers, who stay offline; the run's report lists
  what it read.

**1. Agree the spec.**
- Answer every question, and raise what it didn't ask about: scale, memory, bad input,
  how the product is run.
- Ask for scenarios with known answers, such as "a star on the celestial equator seen from
  30° N transits at 60°". The Planner judges each requirement by them.
- When the plan review says revise and the Manager doesn't, ask it to. Correct any choice it
  made for you that you would make differently.
- Approve an investigation's first command promptly: it waits for you, and the approval
  covers that investigation's other commands.
- Keep one test of your own outside the project, such as running the product on real input
  and looking at the result. Autopilot never sees it, so the work can't be shaped to pass it.

**2. Build.** **Build with Autopilot…**, with the image, a time limit, setup commands, and
downloads if the project installs packages. Merge or drop the previous run first.

**3. While it builds, leave it.** Tasks fail and are retried. A task's first attempt gets two
thirds of its time, so a repair can follow; one that still runs out of time is abandoned,
and the Planner replans it at the next milestone review. With a frontier Planner, each
feature's acceptance test is the Planner's, written from your scenarios before the code, and
no worker can change it. Every milestone review starts over and reads the tests behind each
requirement, so expect a review to cost dollars rather than cents. Look in when an
alert arrives, or once or twice a day. If **Details** shows the same failure in several
tasks, tell Autopilot the rule once with **Message Autopilot**: where the code belongs,
which library to use, what never to do. Don't edit the project folder while a run builds.

**4. When it stops,** the card says why, and the task reasons are under **Details**:

| It says | What to do |
|---|---|
| Paused (its runner stopped) | **Resume** |
| Poundlock or the model stayed unavailable | In Poundlock's console, check the machine that serves the model under **Machines**: wake it or restart its model server, then **Resume** |
| The container runtime stayed unavailable | Start Autopilot's VM again, then **Resume** |
| Setup failed, or the checks fail at the base commit | Read the log it names, fix the project or the flaky check, then **Build again…** |
| *M* is done; Autopilot waits for you | Read the milestone's chips, then **Resume** |
| *M* still has gaps after *n* reviews | **Message Autopilot** what you want and **Resume**, or merge what is verified and **Build again…** |
| 3 cases in a row were blocked or abandoned | Read their reasons: usually one trap. **Message Autopilot** the rule, then **Resume** |
| A task blocked in the worker's own words | Its question is on the card. Type your answer (it goes to the run), then **Resume**; if the worker is wrong, say so |
| A time or Planner spend limit | **Merge into folder…**, then **Build again…** if more is needed |
| On local fallback | Raise your provider's limit or top up; the run goes on locally meanwhile |
| The disk is nearly full | Free space on this Mac, then **Resume** |
| A container in this VM can reach this Mac | Run the command it gives, then **Build again…** |
| The route of a model changed | Review the route in Settings → Models and routing, then start a new run |

In the terminal client the buttons are commands: **Resume** is `/autopilot resume`, **Build
again…** is `/autopilot start --image <name>`, **Message Autopilot** is typing while the run
holds the project (or `/autopilot message <words>`), and **Merge into folder…** is
`/autopilot merge`. From a shell, the same commands follow `dispatch autopilot` (`message
--text <words>`, `merge --yes`). Models and routing is `/models`, `/role` and `/approve-models`.

**5. When it's built,** read the chips, then run your own test. If the product is wrong
though every check passes, tell the Manager what you saw, as a user would ("the stars come
out smeared"), and **Build again…**. Always use **Merge into folder…** before the next
build.

## When something goes wrong

The [troubleshooting table](../README.md#troubleshooting) covers the common messages.
Each project keeps its full history, and each task its evidence: the model, the real
file changes, the checks' output and the review.
