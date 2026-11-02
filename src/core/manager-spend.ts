import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** One priced model call: when it was answered, and what it cost. */
export interface Charge {
  at: string;
  usd: number;
}

/** Each manager reply in a session and its cost, as Pi priced it from the catalog. */
export function sessionCharges(jsonl: string): Charge[] {
  const charges: Charge[] = [];
  for (const line of jsonl.split("\n")) {
    // Pi appends as it goes: a last line still being written is not a reply yet.
    let entry: {
      timestamp?: string;
      message?: { role?: string; usage?: { cost?: { total?: number } } };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.message?.role === "assistant")
      charges.push({ at: entry.timestamp ?? "", usd: entry.message.usage?.cost?.total ?? 0 });
  }
  return charges;
}

/** What one manager session's replies cost. */
export function sessionCost(jsonl: string): number {
  return sessionCharges(jsonl).reduce((sum, charge) => sum + charge.usd, 0);
}

/**
 * A project's manager spend across its sessions. The owner's caps cover the
 * manager as well as the Planner, so the run card shows both (UX research, Oct
 * 2026). Each session file is read again only when it changes.
 */
export class ManagerSpend {
  private readonly read = new Map<string, { size: number; mtimeMs: number; usd: number }>();

  async of(sessionsDir: string): Promise<number> {
    const names = await readdir(sessionsDir).catch(() => [] as string[]);
    let usd = 0;
    for (const name of names.filter((item) => item.endsWith(".jsonl"))) {
      const path = join(sessionsDir, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      const known = this.read.get(path);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) {
        usd += known.usd;
        continue;
      }
      const cost = sessionCost(await readFile(path, "utf8"));
      this.read.set(path, { size: info.size, mtimeMs: info.mtimeMs, usd: cost });
      usd += cost;
    }
    return usd;
  }
}
