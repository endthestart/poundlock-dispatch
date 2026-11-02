import {
  type AutopilotCard,
  dollars,
  duration,
  limitText,
  type VerdictChip,
} from "@shared/autopilot-card";
import { CARD_TONES } from "@shared/status-tone";
import type { ReactNode } from "react";
import "./autopilot-card.css";

const VERDICT: Record<VerdictChip, string> = {
  shown: "shown",
  partly: "partly",
  not_shown: "not shown",
  not_reviewed: "not reviewed",
};

function Meter({
  label,
  used,
  of,
  share,
}: {
  label: string;
  used: string;
  of?: string;
  share?: number;
}) {
  return (
    <div className="run-meter">
      <span className="run-meter-label">{label}</span>
      <span>
        <strong>{used}</strong>
        {of ? <span className="hint"> of {of}</span> : null}
      </span>
      {share !== undefined ? (
        <span className="run-meter-bar" aria-hidden="true">
          <i style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
        </span>
      ) : null}
    </div>
  );
}

/** Autopilot's run card: standing, meters, a verdict per requirement, then what needs you. */
export function AutopilotRunCard({ card, details }: { card: AutopilotCard; details: ReactNode }) {
  const spend = card.plannerSpend;
  return (
    <div className="run-card" data-tone={card.tone}>
      <div className="run-card-head">
        {/* Only the standing is announced: the whole area as a live region re-read its meters on every push. */}
        <span className={`state-pill ${CARD_TONES[card.tone]}`} aria-live="polite">
          {card.headline}
        </span>
        <span className="run-card-summary">{card.summary}</span>
      </div>
      {card.why ? (
        <p className="run-now">
          <span className="hint">Why it stopped:</span> {card.why}
        </p>
      ) : null}
      {card.time || spend || card.managerUsd || card.weekUsd !== undefined ? (
        <div className="run-meters">
          {card.time ? (
            <Meter
              label="Time"
              used={duration(card.time.minutes)}
              of={limitText(card.time.limitHours)}
              share={card.time.minutes / (card.time.limitHours * 60)}
            />
          ) : null}
          {spend ? (
            <Meter
              label="Planner spend"
              used={`$${spend.usd.toFixed(2)}`}
              {...(spend.capUsd !== undefined
                ? { of: `$${dollars(spend.capUsd)}`, share: spend.usd / spend.capUsd }
                : {})}
            />
          ) : null}
          {card.managerUsd ? (
            <Meter label="Manager spend" used={`$${card.managerUsd.toFixed(2)}`} />
          ) : null}
          {card.weekUsd !== undefined ? (
            <Meter label="Last 7 days, all projects" used={`$${card.weekUsd.toFixed(2)}`} />
          ) : null}
        </div>
      ) : null}
      {card.requirements.length ? (
        <ul className="run-requirements" aria-label="Requirements">
          {card.requirements.map((item) => (
            <li
              key={item.id}
              data-verdict={item.verdict}
              title={`${item.id}: ${item.text}${item.note ? `\n${item.note}` : ""}`}
            >
              <span className="run-verdict-dot" aria-hidden="true" />
              <strong>{item.id}</strong>
              <span className="run-requirement-text">{item.text}</span>
              {/* Every verdict in words: shown and not reviewed differed only by colour (UX review, 30 Oct). */}
              <span className="run-verdict-word">
                {VERDICT[item.verdict]}
                {item.advisory ? ", advisory" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {card.requirements.length ? (
        <p className="run-legend">
          Green shown by the Planner, amber partly, red not shown, grey not reviewed yet.
        </p>
      ) : null}
      {card.now ? (
        <p className="run-now">
          <span className="hint">Now:</span> {card.now}
        </p>
      ) : null}
      {card.needsYou.length ? (
        <div className="run-list">
          <strong>Needs you</strong>
          <ul>
            {card.needsYou.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {card.tone !== "active" ? (
        <div className="run-list">
          <strong>Built</strong>
          <ul>
            {card.built.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="autopilot-details">
        <summary>Details</summary>
        {details}
      </details>
    </div>
  );
}
