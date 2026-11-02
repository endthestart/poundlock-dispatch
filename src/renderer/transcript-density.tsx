import type { TranscriptDensity } from "@shared/live-work-view";
import { useState } from "react";
import { useMenu } from "./dialog";

const KEY = "dispatch.transcript.density";

const CHOICES: { density: TranscriptDensity; label: string; hint: string }[] = [
  {
    density: "normal",
    label: "Normal",
    hint: "Each reply's steps folded, and one update between messages.",
  },
  { density: "verbose", label: "Verbose", hint: "Every step and update, as it happened." },
];

function readDensity(): TranscriptDensity {
  try {
    return window.localStorage.getItem(KEY) === "verbose" ? "verbose" : "normal";
  } catch {
    return "normal";
  }
}

/** How much of the work the transcript shows, remembered on this Mac. */
export function useTranscriptDensity(): [TranscriptDensity, (next: TranscriptDensity) => void] {
  const [density, setDensity] = useState(readDensity);
  return [
    density,
    (next) => {
      setDensity(next);
      try {
        window.localStorage.setItem(KEY, next);
      } catch {
        /* storage unavailable */
      }
    },
  ];
}

export function DensityChip({
  density,
  onChange,
}: {
  density: TranscriptDensity;
  onChange: (next: TranscriptDensity) => void;
}) {
  const menu = useMenu();
  const current = CHOICES.find((choice) => choice.density === density)!;
  return (
    <div className="trust-chip">
      <button
        type="button"
        className="trust-chip-btn"
        aria-label={`Transcript density: ${current.label}`}
        {...menu.triggerProps}
      >
        Transcript: {current.label}
      </button>
      {menu.open ? (
        <div
          className="trust-menu menu-popover"
          aria-label="Transcript density"
          {...menu.menuProps}
        >
          {CHOICES.map((choice) => (
            <button
              key={choice.density}
              type="button"
              role="menuitemradio"
              aria-checked={choice.density === density}
              tabIndex={-1}
              className={choice.density === density ? "selected" : undefined}
              onClick={() => {
                menu.close();
                onChange(choice.density);
              }}
            >
              <strong>{choice.label}</strong>
              <span>{choice.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
