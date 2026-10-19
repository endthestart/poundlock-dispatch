# Using Poundlock Dispatch

Dispatch is a project manager and a team of coding workers that run on your own
models through Poundlock. You describe the work; the **Manager** plans it and
reviews the result; **workers** write the code in your project folder. Nothing is
committed or pushed for you.

The desktop app and the `dispatch` terminal client do the same work and share the
connection, model choices and permission defaults. Their project lists are separate.

## Start a project

- **Desktop:** **+** next to Projects, then **Folder on this Mac** or **Git
  repository** (an HTTPS URL and a branch or commit).
- **Terminal:** run `dispatch` in the folder, or `dispatch path/to/folder`.

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

`dispatch` in a folder opens it. Type `/` to list commands. The ones you will use most:

| Command | Does |
|---|---|
| `/approve` | Approve the proposed plan and start. |
| `/board` | The plan and its tasks. Tab switches between them and the conversation. |
| `/pause`, `/resume`, `/cancel` | Control the run. |
| `/trust`, `/network` | This project's permissions and network. |
| `/models`, `/role` | Which models do what. |
| `/compact` | Summarise older context now. |
| `/connect`, `/setup` | The controller and token; what is configured. |
| `/quit` | Exit. |

`dispatch jobs …` drives Poundlock jobs by hand from a shell, and `dispatch auto …` runs auto
mode. Each has `--help`.

## Auto mode

Auto mode works an approved plan unattended, for hours, in a private clone of the
folder. Every command runs in a container on a dedicated VM ([install](INSTALL.md#auto-modes-vm-optional)),
and a case is accepted when the plan's checks pass and its changes stay inside the
plan's scope.

```sh
dispatch auto start --dir . --image python:3.14-slim --plan plan.json
dispatch auto watch            # Ctrl+C leaves it running
dispatch auto stop [--now]
dispatch auto resume
dispatch auto export --out run.patch
```

Nobody reviews auto mode's work, so its results say **verified, not reviewed**. Read the
exported patch before you apply it. A run survives a crash or a reboot; `resume` picks
it up where it stopped.

## When something goes wrong

The [troubleshooting table](../README.md#troubleshooting) covers the common messages.
Each project keeps its full history, and each task its evidence: the model, the real
file changes, the checks' output and the review.
