# ADR 017: Web search for the manager and Planner

Status: accepted, 18 Oct 2026. The first step of roadmap item 2, "Research from the internet".

## Context

The manager and the Planner know only what their model remembers and what the project
holds. Building a clone of a product, they guess at how that product behaves. The owner asked
for search and research, and, with paid credit gone, for a start that costs nothing: a search
engine they host themselves. Public discussions of agents with web search agree on three points: queries leak private context,
fetching meets bot challenges, and self-hosted SearXNG suits private, low-volume use.

## Decision

- **The engine is the owner's own SearXNG**, set once in Settings → Connection → Web search
  (its JSON output turned on). No engine set means no web search anywhere. Paid providers
  can follow behind the same tools once the owner signs up for one.
- **A project opts in with its own switch**, "Web search for the manager and Planner", off
  by default and only available with Internet on. Internet stays about what commands reach
  (ADR 015); web search is a different exposure, because the queries come from the
  project's context.
- **Two read-only tools**, `web_search` and `web_fetch`, for the interactive manager and the
  Autopilot Planner. Workers do not get them: their commands run without network in
  Autopilot's container.
- **Queries stay public.** A query is refused, and the refusal recorded, when it carries a
  file path, a key or token, a long hex or encoded string, an email address, a private address,
  several lines or more than 200 characters, or a private term: the project folder's name,
  this machine's name or its user.
- **Fetches reach the public internet only**: never this Mac or the owner's networks. Every
  hop of a redirect (at most five) is checked again, robots.txt included, and the connection
  is pinned to an address checked at connect time, so a name that re-resolves to a private
  address gains nothing. Fetches honour robots.txt by their own product token, merging an
  agent's groups (a server error or a rate limit reads as "not now", and a failure is asked
  again next time); they back off once on 429 or 503 as Retry-After asks (at most 30 s) and
  then leave the site, never get around a 403 or a challenge, read text only (1.5 MB at most,
  12,000 characters returned, compressed pages decoded first) and send an honest user agent.
  robots.txt patterns and page HTML are read without backtracking regular expressions, so a
  hostile file or page cannot stall the process, and a robots.txt group that applies to us
  and passes the size or rule caps reads as "disallow everything". A site
  whose robots.txt fails is left alone for a minute.
- **Only URLs someone else wrote are fetched**: a URL the engine returned, or a link on a
  page already read (each fetch result lists up to 30 of its page's links). An exact copy of another's URL carries nothing of the project, where a
  URL the model wrote could carry project text in its host, path or query.
- **Each owner turn has caps**: 20 searches and 20 fetches.
- **Fetched text is untrusted.** Results and pages come back marked as data, not
  instructions, closed with an end marker, titles and URLs on one line each. Once a manager
  session has read web content, the tools whose effect lasts (adding a board task, the
  project brief, notes, waiving a requirement, marking the project complete) refuse until the
  owner next writes; a review or retry turn the app starts does not lift the hold. Any
  message from the owner lifts it, since the owner is then present to see what follows.
- **The switch is asked before every call**, so turning web search or the internet off stops
  a live manager session and a running Planner at once. Turning the internet off turns web
  search off with it.
- **Every call is recorded**: a run's ledger gets a `web_call` event per search or fetch,
  refusals included. The manager's calls go to the project's `web-calls.jsonl`.

## Consequences

- The Planner can look up how the product it is cloning behaves, and the owner can read
  every query afterwards.
- The privacy check is a filter, not a proof: a model can still describe private matters in
  ordinary words. Keeping the switch off by default and recording every query are the
  backstops.
- The Planner's answer becomes board tasks without a person in between, so text a page
  plants could shape a task. Workers run in Autopilot's container without network and can
  change only the project, and accepted work reaches the folder only when the owner merges
  it; the switch stays per project.
- Public engines rate-limit and challenge a single SearXNG (Brave and DuckDuckGo did on the
  first query); results come from the engines that answer.
- A manager session keeps the tools it started with: turning web search on for a project, or
  setting up an engine, applies from its next session (turning it off applies at once).
