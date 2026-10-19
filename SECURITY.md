# Security boundaries

Dispatch is a desktop client for trusted operators and approved projects. The
manager plans, delegates and reviews; it has no shell, file writer or patch tool.
Private notes stay in application data and are never executed as checks. Workers
write implementation. Manager-proposed checks select project tests, not inline code.

Direct reads require canonical project scope or a saved exact-file grant. Ignored
and sensitive files require that grant even inside the project. Grants identify a
resolved target, not a redirectable symlink. Removing a grant and saving project
settings pauses active work. Durable snapshots omit excluded files and require
separate consent. Inference destination is declared metadata or explicit operator
policy; unknown is never inferred from model names or gateway type.

In **Approve for me**, structured project commands run only after Dispatch
qualifies the macOS `sandbox-exec` boundary. That boundary limits writes to the
approved project surface, denies known project and account secrets, and supplies a
minimal environment. The profile is passed to `sandbox-exec`
inline, never through a file, and a command's process group is killed when the
command exits. If qualification fails, Dispatch asks instead
of running the command automatically. **Ask for approval** can run an explicitly
approved raw Bash command with the user's account authority. Ordinary in-project
file edits do not wait for a card in Ask; ignored, secret, outside, and
destructive actions still do. **Full access** is
host-user command authority and is not an isolation guarantee. Uploading a project
snapshot for a background job always asks separately.

**Network.** Each project's **Internet** and **Local network** switches (ADR 015) bind
every command a worker runs, in every mode. A sandboxed command gets them in its
profile; an unsandboxed one (Ask, Full access, raw Bash) runs inside a network-only
`sandbox-exec` profile. With one switch on, a command reaches this Mac and a loopback
proxy that resolves each destination, refuses any name with an address on the wrong
side, and connects to the address it checked. Each proxy needs its own random
credential, given only to the commands it serves. This Mac's loopback services count
as the local network. The network-only profile also closes the Docker socket, and name
lookups when there is no network. Dependency installs reach only exact package-registry
read hosts through a separate proxy, and only with Internet on. Known limits: through a
proxy only programs that honour `HTTPS_PROXY` connect; in Ask and Full access the
switches hold the network, not other account authority (files, launch agents); npm,
RubyGems and NuGet
serve downloads and publishes from one host, so a script with its own token for one
of them could publish there; on Linux, where `sandbox-exec` does not exist, the
switches are not enforced and **Approve for me** asks for every command, because
the sandbox cannot be qualified.

Local auto mode (ADR 014) runs unattended, so it does not rely on
`sandbox-exec`. It works in a private clone, never in the attached folder. Every
command, check and setup step runs in a container on a colima VM of its own that
mounts only Dispatch's auto folder; a run refuses a VM that can see the rest of
the home folder unless the owner overrides it for that run. The container mounts
only the run's worktree (writable, except its `.git` file) and its mirror's Git
directory (read-only).
The container has no network, no capabilities, and the owner's uid. Setup gets the
network only when dependency downloads are approved, and only after a probe container
fails to reach a listener on this Mac: the VM's firewall must drop bridge traffic to
the Mac and private networks (L29). A networked setup does not mount the mirror. Dispatch's own Git never follows
the worktree's `.git` file, and no host shell is offered to the worker. The
worktree is written by the model: never run Git in it or open it in an editor
that runs Git. Dispatch checks its `.git` file when a run ends and on export, and
removes the worktree once the run is finished and exported. If the
runtime or image is missing, the run does not start. Results are verified by the
checks, not reviewed. When a task fails only on tests frozen earlier in the run, the Planner may let later
tasks change those tests, giving a reason; each allowance is recorded in the run's
ledger (`frozen_allowed`) but not yet shown in the morning report.

Tokens are stored in private application data files with owner-only permissions;
they are not exposed through renderer state. They are not encrypted at rest. Protect
and back up this directory as credential-bearing data. Commands run through
`run_command`, verification checks and `git_inspect` receive a minimal
environment without app credentials. Raw Bash, offered only in Ask for approval
and Full access, is not: it inherits Dispatch's own environment, including
anything exported in the shell that started the terminal client. Pi resource
discovery is disabled.
Renderer isolation and the desktop IPC sender check restrict the app bridge to the
owned main frame. Project content is rendered as text, not executable HTML.

## Reporting

Report a vulnerability privately with GitHub's **Report a vulnerability** button on
this repository's Security tab. Include a reproduction with synthetic data, the
affected version and build. Do not post credentials, private source or deployment
details in issues or CI logs. One maintainer looks after this project: reports are
acknowledged on a best-effort basis, usually within seven days, and fixes go into
the latest release only.
