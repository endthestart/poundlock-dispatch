import type { AutopilotMergePreview } from "@shared/auto-run";
import { autopilotCard, autopilotResumable } from "@shared/autopilot-card";
import {
  type AutopilotDetails,
  autopilotDetails,
  VERIFIED_LEAD,
  VERIFIED_TAIL,
} from "@shared/autopilot-details";
import { type AutopilotStartPreview, autopilotStartPreview } from "@shared/autopilot-start";
import type { AppStateView } from "@shared/types";
import { useEffect, useState } from "react";
import { AutopilotRunCard } from "./autopilot-card";
import { AutopilotCleanupDialog, AutopilotDropDialog } from "./autopilot-cleanup";
import { Dialog, usePendingAction } from "./dialog";

type Run = <T>(work: () => Promise<T>) => Promise<T | undefined>;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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
  const { pending, act } = usePendingAction(run);
  const [starting, setStarting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [cleaning, setCleaning] = useState(false);
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

  const disabled = Boolean(pending);
  const live = view && (view.phase === "preparing" || view.phase === "running");
  const verified = view?.cases.filter((item) => item.stage === "accepted").length ?? 0;
  // Verdicts live on the approved plan the run built, not on a revision still pending.
  const builtPlan = selected.plan;

  return (
    <section className="decision-dock autopilot-dock" aria-label="Autopilot">
      <div className="dock-block" aria-busy={disabled}>
        {view ? (
          <AutopilotRunCard
            card={autopilotCard(
              view,
              builtPlan?.requirements ?? [],
              new Date(),
              selected.managerUsd,
              state.weekUsd,
            )}
            details={<RunDetails details={autopilotDetails(view)} />}
          />
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
          {autopilotResumable(view) ? (
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
                {view?.stopRequested ? "Stop asked for" : "Stop after this task"}
              </button>
              <button
                type="button"
                onClick={() => document.getElementById("composer-input")?.focus()}
              >
                Message Autopilot
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
            <button
              type="button"
              className={view.outcome === "objective_met" ? "primary" : undefined}
              disabled={disabled}
              onClick={() => setMerging(true)}
            >
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
          {view &&
          !view.dropped &&
          view.workingCopy &&
          (view.phase === "ended" || view.phase === "interrupted") ? (
            <button
              type="button"
              className="danger quiet"
              disabled={disabled}
              onClick={() => setDropping(true)}
            >
              Drop run…
            </button>
          ) : null}
          {view && !live ? (
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              onClick={() => setCleaning(true)}
            >
              Clean up runs…
            </button>
          ) : null}
        </div>
      </div>
      {dropping ? (
        <AutopilotDropDialog
          onClose={() => setDropping(false)}
          onDrop={() =>
            act("Dropping the Autopilot run…", () => window.poundlockDispatch.autopilotDrop())
          }
        />
      ) : null}
      {cleaning ? (
        <AutopilotCleanupDialog
          onClose={() => setCleaning(false)}
          onCleanup={(runIds) =>
            act("Removing the runs' working copies…", () =>
              window.poundlockDispatch.autopilotCleanup(runIds),
            )
          }
        />
      ) : null}
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
          preview={autopilotStartPreview(state, selected)}
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

function AutopilotStartDialog({
  preview: { defaultImage, approve, goal, suggestedChecks, defaultHours },
  onClose,
  onSubmit,
}: {
  preview: AutopilotStartPreview;
  onClose: () => void;
  onSubmit: (options: {
    image: string;
    hours: number;
    allowDependencyDownloads: boolean;
    acceptAlreadyMet: boolean;
    prepare: string[];
    checks?: string[];
    checkpoint?: "notify" | "wait";
    allowPlannerDestination?: string;
    plannerSpendCapUsd?: number;
  }) => Promise<unknown>;
}) {
  const [image, setImage] = useState(defaultImage);
  const [hours, setHours] = useState(String(defaultHours));
  const [downloads, setDownloads] = useState(false);
  const [alreadyMet, setAlreadyMet] = useState(false);
  const [prepare, setPrepare] = useState("");
  const [checks, setChecks] = useState((suggestedChecks ?? []).join("\n"));
  const [checkpoint, setCheckpoint] = useState<"notify" | "wait">("notify");
  const [agreed, setAgreed] = useState(false);
  const [cap, setCap] = useState("5");
  const [busy, setBusy] = useState(false);
  const parsedHours = Number(hours);
  const needsAgreement = Boolean(goal?.planner?.external);
  const parsedCap = Number(cap);
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const valid =
    image.trim() &&
    (!suggestedChecks || lines(checks).length > 0) &&
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
            prepare: lines(prepare),
            ...(suggestedChecks ? { checks: lines(checks) } : {}),
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
        {suggestedChecks ? (
          <>
            <label htmlFor="autopilot-checks">Checks (one per line)</label>
            <textarea
              id="autopilot-checks"
              value={checks}
              placeholder="cargo test --release"
              onChange={(event) => setChecks(event.target.value)}
            />
            <p className="hint">
              Every task must pass these. They become the project's checks
              {suggestedChecks.length ? "; the manager suggested them with the plan" : ""}.
            </p>
          </>
        ) : null}
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

function RunDetails({ details }: { details: AutopilotDetails }) {
  return (
    <>
      <p className="hint">
        {details.stopping ? `${details.stopping} ` : ""}
        {VERIFIED_LEAD}
        <code>{details.branch}</code>
        {VERIFIED_TAIL}
        {details.planner ? ` ${details.planner}` : ""}
      </p>
      <ul className="autopilot-lines">
        {details.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <ol className="autopilot-cases">
        {details.cases.map((item) => (
          <li key={item.id} data-stage={item.stage}>
            <span className="autopilot-stage">{item.label}</span> {item.title}
            {item.reason ? <span className="hint"> — {item.reason}</span> : null}
          </li>
        ))}
      </ol>
    </>
  );
}
