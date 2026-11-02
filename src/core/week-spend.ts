import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AutoEvent, plannerCostOf } from "@shared/auto-run";
import { type Charge, sessionCharges } from "./manager-spend.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FRESH_MS = 60_000;

/** Each Planner call a run paid for, as its ledger records it (the same rule as the run's total). */
export function plannerCharges(eventsJsonl: string): Charge[] {
  const charges: Charge[] = [];
  for (const line of eventsJsonl.split("\n")) {
    let entry: { at?: string; event?: AutoEvent };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usd = entry.event ? plannerCostOf(entry.event) : 0;
    if (usd && entry.at) charges.push({ at: entry.at, usd });
  }
  return charges;
}

/**
 * What the manager and the Planner cost in the last 7 days, across every
 * project and run: the run card's week meter (UX research, Oct 2026). Each
 * file is read again only when it changes, and the total at most once a minute.
 */
export class WeekSpend {
  private readonly files = new Map<string, { size: number; mtimeMs: number; charges: Charge[] }>();
  private last: { at: number; usd: number } | undefined;

  async total(sessionDirs: string[], runsRoot: string | undefined, now: Date): Promise<number> {
    if (this.last && now.getTime() - this.last.at < FRESH_MS) return this.last.usd;
    const since = new Date(now.getTime() - WEEK_MS).toISOString();
    const sessions = await Promise.all(
      sessionDirs.map(async (dir) =>
        (await readdir(dir).catch(() => [] as string[]))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => ({ path: join(dir, name), parse: sessionCharges })),
      ),
    );
    const runs = runsRoot
      ? (await readdir(runsRoot).catch(() => [] as string[])).map((name) => ({
          path: join(runsRoot, name, "events.jsonl"),
          parse: plannerCharges,
        }))
      : [];
    let usd = 0;
    for (const file of [...sessions.flat(), ...runs])
      for (const charge of await this.charges(file.path, file.parse))
        if (charge.at >= since) usd += charge.usd;
    this.last = { at: now.getTime(), usd };
    return usd;
  }

  private async charges(path: string, parse: (text: string) => Charge[]): Promise<Charge[]> {
    const info = await stat(path).catch(() => undefined);
    if (!info) return [];
    const known = this.files.get(path);
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.charges;
    const charges = parse(await readFile(path, "utf8"));
    this.files.set(path, { size: info.size, mtimeMs: info.mtimeMs, charges });
    return charges;
  }
}
