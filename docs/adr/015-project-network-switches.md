# ADR 015: Project network switches

Status: accepted, 5 Oct 2026 (Dispatch 0.2.0)

## Context

Network access for commands was decided per command: the worker asked for `deny`,
`dependency` or `allow`, `allow` needed Full access, and package downloads needed the
approved plan's say-so. It did not separate the internet from the owner's own network,
and in Ask and Full access commands ran unsandboxed with full network. The owner asked for
something intuitive: a project either has internet access or it does not, and either has
local network access or it does not, without approving each command or listing hosts.

## Decision

Each project has two switches in its settings, also set with `/network` in the TUI:

| Switch | Default | Means |
|---|---|---|
| Internet | on | Commands reach public addresses. |
| Local network | off | Commands reach this Mac's own services and private addresses: the LAN, link-local, CGNAT and Tailscale ranges. |

They hold for every command a worker runs, whatever the permission mode:

| Internet | Local network | What a command gets |
|---|---|---|
| on | on | Direct network. |
| on | off | Only its own loopback proxy, which refuses private and loopback addresses after resolving them. |
| off | on | This Mac's services, and its own loopback proxy, which refuses public addresses. |
| off | off | No network. |

- Sandboxed commands (Assist, read-only) get the rule in their sandbox profile. Commands that
  run unsandboxed (Ask, Full access, raw Bash) run inside a network-only sandbox profile
  that also closes the Docker socket (and name lookups when there is no network) and
  otherwise leaves the account's authority as the mode gives it. In those modes the
  switches hold the network, not everything a command could do as the user.
- Each proxy requires a random credential that only the commands it serves receive, so a
  command cannot reach the other switch setting's proxy on loopback.
- Through a proxy, only programs that honour `HTTPS_PROXY`/`HTTP_PROXY` connect. Most
  developer tools do; SSH and raw sockets need both switches on.
- Dependency installs keep the registry-only proxy (L19) and need Internet on. The plan's
  download flag no longer gates them.
- A worker may still ask for no network (`deny`). Asking for `allow` means "what the project
  allows"; it no longer needs Full access.
- Durable jobs ask Poundlock for outbound access when Internet is on and the controller
  offers it. They never reach the local network (Poundlock M5).
- Read-only investigations still have no network.
- Remembered command approvals no longer include the network, so saved approvals from
  0.1.x are asked once more.

## Consequences

- One mental model, two switches, no per-command network prompts.
- macOS only: `sandbox-exec` enforces the rule. Where it is unavailable (Linux), the
  switches are not enforced and commands keep the network they had before.
- A network change takes effect at the next command; it does not pause running work.
- Auto mode keeps its own isolation and setting for now (ADR 014): its cases have no
  network, and setup has it only with `--allow-dependency-downloads`.
- Per-host lists remain possible later as an advanced option; they are not the default.
