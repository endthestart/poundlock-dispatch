/** Named Dispatch use cases. Fake/scripted rows always run; live rows skip without env. */

export const DISPATCH_USE_CASES = [
  {
    id: "U1",
    title: "Discussion only",
    manager: "local LLM (vega-general or Settings manager)",
    worker: "none",
    assert: "Manager replies in-session; no tasks or jobs",
    how: "Live skip-gated; unit with scripted manager",
  },
  {
    id: "U2",
    title: "Plan and execute interactively",
    manager: "local LLM",
    worker: "local interactive sub-agent",
    assert: "Plan approved; interactive attempt; file appears in attached folder",
    how: "Live skip-gated; unit with fake Pi/Poundlock",
  },
  {
    id: "U3",
    title: "Frontier plan, local execute",
    manager: "frontier (e.g. frontier-gpt-sol)",
    worker: "local interactive",
    assert: "No false route-changed vs Settings default; worker is local profile",
    how: "Unit always; live skip-gated",
  },
] as const;
