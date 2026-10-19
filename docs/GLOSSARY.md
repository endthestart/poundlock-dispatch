# Poundlock Dispatch glossary

This document defines approved vocabulary for the Poundlock Dispatch client. Terms are self-contained; aliases use identical profiles unless otherwise noted.

- **Poundlock Dispatch**: Poundlock client family owning projects, conversations, plans, permissions and review across GUI and future CLI/TUI/editor surfaces. Lockkeep is the legacy implementation name.
- **Poundlock Dispatch GUI**: The Electron desktop interface, packaged as `Poundlock Dispatch.app`. Version 0.1.1 migrates existing settings and projects by copying legacy data, retaining the original as a backup.
- **Client computer**: Machine running the Dispatch runtime and attached interactive Pi worker tools.
- **Poundlock controller**: API/runtime scheduling service; not the project manager.
- **Operator network**: Operator-controlled machines/network, including inference nodes such as a separate Mac. Avoid equating local with same computer.
- **External provider**: Inference outside operator-controlled network.
- **Inference destination**: Operator declaration data_destination: unknown, operator_network, external. Descriptive, not routing enforcement. Missing/unrecognized is unknown. Never infer from model name or adapter.
- **Gateway/adapter**: Connection mechanism, e.g. OpenAI-compatible or LiteLLM; independent of inference destination/quality.
- **Manager**: Plans/delegates/reviews, no repo implementation tools.
- **Worker**: Separate Pi session doing bounded implementation/checks.
- **Interactive work**: Worker tools run on client computer, selected context sent to Poundlock inference, no tree upload; stops if client quits.
- **Durable job**: Isolated Poundlock job with submitted source that survives client disconnect. Dispatch never starts one itself; they are run by hand with `dispatch jobs`.
- **Model profile**: Configured model/limits/routing identity; aliases same profile, not more capacity.
- **Execution role**: Manager/interactive/repair etc user mapping, not a property inferred from model names.
- **Capacity slot**: Managed node/runtime exclusivity; busy=false is not proof ready or reserved.

Preferred terminology: 'operator network', 'client computer', 'external provider', 'source upload'. Avoid ambiguous 'off-box'/'leaves this computer'.

This glossary describes approved MVP vocabulary; it does not claim all workflows have been implemented or live-verified.

- **Client runtime**: Reusable Pi-based project/session, policy and orchestration behavior in `src/runtime` and `src/core`. Electron adapters host it; they do not duplicate the agent loop.
- **Qualified tier**: Operator-defined task suitability based on an exact model/harness/tools/settings configuration; independent of role, execution path and destination.
- **Standing escalation authorization**: Prior permission for automatic transitions within an explicit scope and limits; not unlimited authority.
- **Budget-aware escalation**: An approved transition conditional on a valid budget decision. Reported remaining balance is advisory unless the required enforcement is established.

ADRs 001, 006 and 008 distinguish the accepted forward direction from current MVP
implementation. GUI-first does not mean GUI-only. Extra surfaces and business
budget/authorization capabilities are separate future acceptance slices.
