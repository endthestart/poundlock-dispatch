import {
  type AutopilotMergePreview,
  type AutopilotView,
  type CaseStage,
  DEFAULT_AUTO_LIMITS,
} from "@shared/auto-run";
import { autopilotPlannerFor } from "@shared/autopilot-tier";
import { autopilotProgressLine } from "@shared/task-view";
import type { AppStateView } from "@shared/types";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog";

type Run = <T>(work: () => Promise<T>) => Promise<T | undefined>;

const PHASE: Record<AutopilotView["phase"], string> = {
  preparing: "Preparing the container and checking the base",
  running: "Building",
  interrupted: "Interrupted: its runner is not running",
  ended: "Ended",
};

const STAGE: Record<CaseStage, string> = {
  pending: "waiting",
  running: "working",
  repairing: "repairing",
  accepted: "verified",
  blocked: "blocked",
  abandoned: "abandoned",
  skipped: "skipped",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const ACTIVE_STATUSES = ["running", "waiting_for_capacity", "reviewing"];

/**
 * Autopilot (ADR 016): build the approved plan unattended in the confined VM,
 * and follow the run. The run outlives the app; reopening shows it again.
 */
export function AutopilotPanel({
  state,
  selected,
  run,
}: {
  state: AppStateView;
  selected: NonNullable<AppStateView["snapshot"]>;
  run: Run;
}) {
  const [pending, setPending] = useState("");
  const [starting, setStarting] = useState(false);
  const [merging, setMerging] = useState(false);
  const pendingRef = useRef(false);
  const view = state.autopilot;
  const project = selected.project;
  const tasks = selected.pendingBoard?.tasks ?? selected.tasks;
  const offer =
    state.autopilotAvailable &&
    project.source.kind === "local_folder" &&
    Boolean(selected.pendingBoard?.plan ?? selected.plan) &&
    tasks.length > 0 &&
    !ACTIVE_STATUSES.includes(project.status) &&
    (!view || view.phase === "ended");
  if (!view && !offer) return null;

  async function act(label: string, work: () => Promise<unknown>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    try {
      await run(work);
    } finally {
      pendingRef.current = false;
      setPending("");
    }
  }
  const disabled = Boolean(pending);
  const live = view && (view.phase === "preparing" || view.phase === "running");
  const verified = view?.cases.filter((item) => item.stage === "accepted").length ?? 0;

  return (
    <section className="decision-dock autopilot-dock" aria-label="Autopilot">
      <div className="dock-block" aria-live="polite" aria-busy={disabled}>
        {view ? (
          <>
            <div className="dock-status">
              <strong>
                Autopilot ·{" "}
                {view.phase === "ended"
                  ? capitalised(view.outcomeLabel ?? PHASE.ended)
                  : PHASE[view.phase]}
                {view.stopRequested && view.phase !== "ended"
                  ? view.stopRequested === "now"
                    ? " · stopping now"
                    : " · stopping after this task"
                  : ""}
              </strong>
              <span className="hint">
                {autopilotProgressLine(
                  view.cases.map((item) => item.stage),
                  "",
                )}{" "}
                Verified means the checks passed; nothing is reviewed. The work is on branch{" "}
                <code>{view.branch}</code>; nothing is applied to your folder.
              </span>
            </div>
            {view.goal ? (
              <p className="hint autopilot-milestones">
                Planner {view.goal.planner}
                {view.goal.advisory ? " (advising only)" : ""} ·{" "}
                {view.milestones?.length
                  ? view.milestones
                      .map(
                        (item) =>
                          `${item.id} ${item.stage === "done" ? (item.gaps?.length ? `done, gaps ${item.gaps.join(", ")}` : "verified") : item.reviews ? `review ${item.reviews}` : "planned"}`,
                      )
                      .join(" · ")
                  : "first milestone under way"}
              </p>
            ) : null}
            {view.endReason && view.outcome !== "objective_met" ? (
              <p className="hint">{view.endReason}</p>
            ) : null}
            <details className="autopilot-details">
              <summary>Progress</summary>
              <ul className="autopilot-lines">
                {view.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <ol className="autopilot-cases">
                {view.cases.map((item) => (
                  <li key={item.id} data-stage={item.stage}>
                    <span className="autopilot-stage">{STAGE[item.stage]}</span> {item.title}
                    {item.reason ? <span className="hint"> — {item.reason}</span> : null}
                  </li>
                ))}
              </ol>
            </details>
          </>
        ) : (
          <div className="dock-status">
            <strong>Build with Autopilot</strong>
            <span className="hint">
              Autopilot works the approved plan task by task in a confined container, accepts each
              one only when the checks pass, and keeps going until the plan is done or a limit is
              reached. It keeps running if you quit the app.
            </span>
          </div>
        )}
        {pending ? (
          <p role="status" className="action-receipt">
            {pending}
          </p>
        ) : null}
        <div className="dock-actions">
          {offer ? (
            <button
              type="button"
              className={view ? undefined : "primary"}
              disabled={disabled}
              onClick={() => setStarting(true)}
            >
              {view ? "Build again…" : "Build with Autopilot…"}
            </button>
          ) : null}
          {view &&
          (view.phase === "interrupted" ||
            (view.phase === "ended" && view.outcome !== "objective_met")) ? (
            <button
              type="button"
              className="primary"
              disabled={disabled}
              onClick={() =>
                void act("Resuming Autopilot…", () => window.poundlockDispatch.autopilotResume())
              }
            >
              Resume
            </button>
          ) : null}
          {live ? (
            <>
              <button
                type="button"
                disabled={disabled || Boolean(view?.stopRequested)}
                onClick={() =>
                  void act("Asking Autopilot to stop after this task…", () =>
                    window.poundlockDispatch.autopilotStop("after_case"),
                  )
                }
              >
                Stop after this task
              </button>
              <button
                type="button"
                className="danger quiet"
                disabled={disabled || view?.stopRequested === "now"}
                onClick={() =>
                  void act("Stopping Autopilot now…", () =>
                    window.poundlockDispatch.autopilotStop("now"),
                  )
                }
              >
                Stop now
              </button>
            </>
          ) : null}
          {view?.phase === "interrupted" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void act("Stopping Autopilot…", () =>
                  window.poundlockDispatch.autopilotStop("after_case"),
                )
              }
            >
              Stop
            </button>
          ) : null}
          {verified > 0 ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void act("Exporting Autopilot's verified work…", () =>
                  window.poundlockDispatch.autopilotExport(),
                )
              }
            >
              Export patch…
            </button>
          ) : null}
          {view?.phase === "ended" && verified > 0 ? (
            <button type="button" disabled={disabled} onClick={() => setMerging(true)}>
              Merge into folder…
            </button>
          ) : null}
          {view?.report ? (
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              onClick={() =>
                void act("Opening the report…", () => window.poundlockDispatch.autopilotReport())
              }
            >
              Open report
            </button>
          ) : null}
        </div>
      </div>
      {merging ? (
        <AutopilotMergeDialog
          onClose={() => setMerging(false)}
          onMerge={() =>
            act("Merging Autopilot's verified work…", () =>
              window.poundlockDispatch.autopilotMerge(),
            )
          }
        />
      ) : null}
      {starting ? (
        <AutopilotStartDialog
          defaultImage={view?.image ?? ""}
          approve={!selected.plan?.approved || Boolean(selected.pendingBoard)}
          goal={goalPreview(state, selected)}
          onClose={() => setStarting(false)}
          onSubmit={(options) =>
            act("Starting Autopilot: checking the image and the VM…", () =>
              window.poundlockDispatch.autopilotStart(options),
            )
          }
        />
      ) : null}
    </section>
  );
}

/** For a plan with milestones: how many, and the Planner the run would use. */
interface GoalPreview {
  milestones: number;
  planner?: { name: string; advisory: boolean; external: boolean; destination: string };
}

function goalPreview(
  state: AppStateView,
  selected: NonNullable<AppStateView["snapshot"]>,
): GoalPreview | undefined {
  const plan = selected.pendingBoard?.plan ?? selected.plan;
  if (!plan?.milestones?.length) return undefined;
  const models = state.probe?.interactiveModels ?? [];
  const find = (id?: string) =>
    id ? models.find((model) => model.profileId === id || model.id === id) : undefined;
  const worker = find(state.connection.roles.interactive?.profileId);
  const verifier = find(state.connection.roles.verifier?.profileId);
  if (!worker && !verifier) return { milestones: plan.milestones.length };
  const choice = autopilotPlannerFor(verifier, (verifier ?? worker)!);
  return {
    milestones: plan.milestones.length,
    planner: {
      name: choice.model.id,
      advisory: choice.advisory,
      external: choice.external,
      destination: choice.model.dataDestination ?? "unknown",
    },
  };
}

function AutopilotStartDialog({
  defaultImage,
  approve,
  goal,
  onClose,
  onSubmit,
}: {
  defaultImage: string;
  approve: boolean;
  goal?: GoalPreview;
  onClose: () => void;
  onSubmit: (options: {
    image: string;
    hours: number;
    allowDependencyDownloads: boolean;
    acceptAlreadyMet: boolean;
    prepare: string[];
    checkpoint?: "notify" | "wait";
    allowPlannerDestination?: string;
    plannerSpendCapUsd?: number;
  }) => Promise<unknown>;
}) {
  const [image, setImage] = useState(defaultImage);
  const [hours, setHours] = useState(goal ? String(DEFAULT_AUTO_LIMITS.softHours) : "6");
  const [downloads, setDownloads] = useState(false);
  const [alreadyMet, setAlreadyMet] = useState(false);
  const [prepare, setPrepare] = useState("");
  const [checkpoint, setCheckpoint] = useState<"notify" | "wait">("notify");
  const [agreed, setAgreed] = useState(false);
  const [cap, setCap] = useState("5");
  const [busy, setBusy] = useState(false);
  const parsedHours = Number(hours);
  const needsAgreement = Boolean(goal?.planner?.external);
  const parsedCap = Number(cap);
  const valid =
    image.trim() &&
    Number.isFinite(parsedHours) &&
    parsedHours > 0 &&
    (!needsAgreement || (agreed && Number.isFinite(parsedCap) && parsedCap > 0));
  return (
    <Dialog
      title="Build with Autopilot"
      description={
        approve
          ? "This approves the proposed plan without starting interactive work, then builds it unattended."
          : "Autopilot builds the approved plan unattended, from your folder's last commit."
      }
      onClose={onClose}
      busy={busy}
      initialFocus="#autopilot-image"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setBusy(true);
          void onSubmit({
            image: image.trim(),
            hours: parsedHours,
            allowDependencyDownloads: downloads,
            acceptAlreadyMet: alreadyMet,
            prepare: prepare
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            ...(goal ? { checkpoint } : {}),
            ...(needsAgreement && goal?.planner
              ? { allowPlannerDestination: goal.planner.destination, plannerSpendCapUsd: parsedCap }
              : {}),
          }).finally(() => {
            setBusy(false);
            onClose();
          });
        }}
      >
        <label htmlFor="autopilot-image">Toolchain image</label>
        <input
          id="autopilot-image"
          value={image}
          placeholder="for example node:22-slim"
          onChange={(event) => setImage(event.target.value)}
        />
        <p className="hint">
          The checks and every command run in this image, in the confined VM, with no network.
        </p>
        <label htmlFor="autopilot-hours">Time limit (hours)</label>
        <input
          id="autopilot-hours"
          inputMode="decimal"
          value={hours}
          onChange={(event) => setHours(event.target.value)}
        />
        <label htmlFor="autopilot-prepare">Setup commands (one per line, optional)</label>
        <textarea
          id="autopilot-prepare"
          value={prepare}
          placeholder="uv sync --frozen"
          onChange={(event) => setPrepare(event.target.value)}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={downloads}
            onChange={(event) => setDownloads(event.target.checked)}
          />
          Let setup download dependencies (in a throwaway container that cannot reach this Mac)
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={alreadyMet}
            onChange={(event) => setAlreadyMet(event.target.checked)}
          />
          Accept a task whose work is already in the code (experimental: the worker's word is taken
          until the milestone's next review)
        </label>
        {goal ? (
          <fieldset className="autopilot-goal">
            <legend>
              The goal: {goal.milestones} milestone{goal.milestones === 1 ? "" : "s"}
            </legend>
            <p className="hint">
              {goal.planner
                ? goal.planner.advisory
                  ? `${goal.planner.name} plans each milestone and reviews it once; with no Verifier model chosen, its reviews only advise.`
                  : `${goal.planner.name}, your Verifier, plans each milestone and reviews it against its requirements; gaps get more tasks.`
                : "Choose a Worker or Verifier model in Settings first."}
            </p>
            <label className="checkbox-row">
              <input
                type="radio"
                name="autopilot-checkpoint"
                checked={checkpoint === "notify"}
                onChange={() => setCheckpoint("notify")}
              />
              Keep going after each milestone
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                name="autopilot-checkpoint"
                checked={checkpoint === "wait"}
                onChange={() => setCheckpoint("wait")}
              />
              Stop at each milestone until I resume
            </label>
            {needsAgreement && goal.planner ? (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                />
                {goal.planner.name} may read this project and send excerpts of its code to{" "}
                {goal.planner.destination.replaceAll("_", " ")}
              </label>
            ) : null}
            {needsAgreement ? (
              <>
                <label htmlFor="autopilot-cap">Planner spend cap (US dollars, an estimate)</label>
                <input
                  id="autopilot-cap"
                  inputMode="decimal"
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                />
              </>
            ) : null}
          </fieldset>
        ) : null}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !valid}>
            {approve ? "Approve and build" : "Build"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shows what a merge brings, checked first, before the owner fast-forwards the folder. */
function AutopilotMergeDialog({
  onClose,
  onMerge,
}: {
  onClose: () => void;
  onMerge: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<AutopilotMergePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.poundlockDispatch
      .autopilotMergePreview()
      .then(setPreview)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, []);
  return (
    <Dialog
      title="Merge Autopilot's work into the folder"
      description="Fast-forwards the folder's current branch to the run's last verified commit. The work was verified by the checks, not reviewed."
      onClose={onClose}
      busy={busy}
      initialFocus="[data-cancel]"
    >
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : preview ? (
        <>
          <p>
            {plural(preview.commits, "commit")}, {plural(preview.files, "file")} changed, up to{" "}
            <code>{preview.head.slice(0, 12)}</code>.
          </p>
          {preview.runsHere.length ? (
            <p className="notice error" role="alert">
              These run on this Mac once merged; review them first: {preview.runsHere.join(", ")}
            </p>
          ) : null}
        </>
      ) : (
        <p className="hint">Checking the folder…</p>
      )}
      <div className="dialog-actions">
        <button type="button" data-cancel disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !preview}
          onClick={() => {
            setBusy(true);
            void onMerge().finally(() => {
              setBusy(false);
              onClose();
            });
          }}
        >
          Merge
        </button>
      </div>
    </Dialog>
  );
}
