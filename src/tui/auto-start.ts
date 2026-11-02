/**
 * `/autopilot start` without flags: the app's "Build with Autopilot" dialog as
 * a few questions, one at a time. What it offers — approving a pending plan,
 * confirming the manager's checks, the goal's milestones and its Planner — is
 * the app's own preview; the answers go to the host's start, as the app's do.
 */
import type { AutopilotStartOptions } from "@shared/auto-run";
import type { AutopilotStartPreview } from "@shared/autopilot-start";

export interface StartQuestions {
  /** A line of text; `undefined` when the owner cancels. */
  text(title: string, detail: string[], initial?: string): Promise<string | undefined>;
  /** One of `items`; `undefined` when the owner cancels. */
  choose(
    title: string,
    items: Array<{ value: string; label: string; description?: string }>,
  ): Promise<string | undefined>;
}

/** Lines typed one at a time, ended by an empty one. */
async function list(
  ask: StartQuestions,
  title: (number: number) => string,
  detail: string[],
): Promise<string[] | undefined> {
  const items: string[] = [];
  for (;;) {
    const line = await ask.text(title(items.length + 1), detail);
    if (line === undefined) return undefined;
    if (!line.trim()) return items;
    items.push(line.trim());
  }
}

const yesNo = (yes: string, no: string, yesFirst = false) => {
  const items = [
    { value: "no", label: no },
    { value: "yes", label: yes },
  ];
  return yesFirst ? items.reverse() : items;
};

/** The start options, or `undefined` when the owner cancelled at any question. */
export async function askStartOptions(
  preview: AutopilotStartPreview,
  ask: StartQuestions,
): Promise<AutopilotStartOptions | undefined> {
  const image = (
    await ask.text(
      "Toolchain image",
      ["The checks and every command run in this image, in the confined VM, with no network."],
      preview.defaultImage,
    )
  )?.trim();
  if (image === undefined) return undefined;
  if (!image) throw new Error("Choose the toolchain image Autopilot runs checks in.");
  const hoursText = await ask.text("Time limit (hours)", [], String(preview.defaultHours));
  if (hoursText === undefined) return undefined;
  const hours = Number(hoursText);
  if (!Number.isFinite(hours) || hours <= 0)
    throw new Error("The time limit is a number of hours above 0.");

  let checks: string[] | undefined;
  if (preview.suggestedChecks) {
    const suggested = preview.suggestedChecks;
    const choice = suggested.length
      ? await ask.choose("Checks: every task must pass these, and they become the project's", [
          { value: "use", label: "Use the manager's checks", description: suggested.join(" · ") },
          { value: "own", label: "Type my own" },
        ])
      : "own";
    if (choice === undefined) return undefined;
    checks =
      choice === "use"
        ? suggested
        : await list(ask, (n) => `Check ${n}`, [
            "One command per line; an empty line ends the list.",
          ]);
    if (checks === undefined) return undefined;
    if (!checks.length) throw new Error("Autopilot needs at least one check to accept a task.");
  }
  const prepare = await list(ask, (n) => `Setup command ${n} (optional)`, [
    "Run before the checks, for example uv sync --frozen. An empty line ends the list.",
  ]);
  if (prepare === undefined) return undefined;
  const downloads = await ask.choose(
    "Let setup download dependencies?",
    yesNo("Yes, in a throwaway container that cannot reach this Mac", "No"),
  );
  if (downloads === undefined) return undefined;
  const alreadyMet = await ask.choose(
    "Accept a task whose work is already in the code?",
    yesNo("Yes (experimental: the worker's word is taken until the milestone's next review)", "No"),
  );
  if (alreadyMet === undefined) return undefined;

  const options: AutopilotStartOptions = {
    image,
    hours,
    allowDependencyDownloads: downloads === "yes",
    acceptAlreadyMet: alreadyMet === "yes",
    prepare,
    ...(checks ? { checks } : {}),
  };
  const goal = preview.goal;
  if (goal) {
    const checkpoint = await ask.choose(
      `The goal: ${goal.milestones} milestone${goal.milestones === 1 ? "" : "s"}`,
      [
        { value: "notify", label: "Keep going after each milestone" },
        { value: "wait", label: "Stop at each milestone until I resume" },
      ],
    );
    if (checkpoint !== "notify" && checkpoint !== "wait") return undefined;
    options.checkpoint = checkpoint;
    if (goal.planner?.external) {
      const agreed = await ask.choose(
        `${goal.planner.name} may read this project and send excerpts of its code to ${goal.planner.destination.replaceAll("_", " ")}`,
        yesNo("I agree", "Cancel"),
      );
      if (agreed !== "yes") return undefined;
      const cap = await ask.text("Planner spend cap (US dollars, an estimate)", [], "5");
      if (cap === undefined) return undefined;
      const usd = Number(cap);
      if (!Number.isFinite(usd) || usd <= 0)
        throw new Error("The spend cap is a dollar amount above 0.");
      options.allowPlannerDestination = goal.planner.destination;
      options.plannerSpendCapUsd = usd;
    }
  }
  const go = await ask.choose(
    preview.approve
      ? "This approves the proposed plan without starting interactive work, then builds it unattended."
      : "Autopilot builds the approved plan unattended, from your folder's last commit.",
    [
      { value: "go", label: preview.approve ? "Approve and build" : "Build" },
      { value: "cancel", label: "Cancel" },
    ],
  );
  return go === "go" ? options : undefined;
}
