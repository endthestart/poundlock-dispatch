import type { ConnectionProbe, ConnectionSettings } from "@shared/types";

/** Shared UI discovery. Refreshing never changes project policy or runtime state. */
export class ServerDiscovery {
  probe?: ConnectionProbe;
  refreshing = false;
  updatedAt?: string;
  private generation = 0;
  private pending?: Promise<void>;
  private usagePending?: Promise<void>;

  constructor(
    private fetchProbe: (connection: ConnectionSettings) => Promise<ConnectionProbe>,
    private notify: () => void,
    private fetchUsage?: (
      connection: ConnectionSettings,
    ) => Promise<import("@shared/types").ManagedIdentityUsage[] | undefined>,
  ) {}

  invalidate(): void {
    this.generation++;
    this.pending = undefined;
    this.usagePending = undefined;
    this.probe = undefined;
    this.updatedAt = undefined;
    this.refreshing = false;
  }

  refresh(connection: ConnectionSettings): Promise<void> {
    if (!connection.url || !connection.token) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.refreshing = true;
    this.notify();
    this.pending = (async () => {
      try {
        const result = await this.fetchProbe(connection);
        if (generation !== this.generation) return;
        this.probe =
          result.ok || !this.probe
            ? result
            : {
                ...this.probe,
                ok: false,
                ready: result.ready,
                error: result.error,
                hint: result.hint,
              };
        if (result.ok) this.updatedAt = new Date().toISOString();
      } catch (error) {
        if (generation !== this.generation) return;
        this.probe = {
          ...(this.probe ?? {
            url: connection.url,
            permissions: [],
            missingPermissions: [],
            durableModels: [],
            interactiveModels: [],
            harnesses: [],
            gitHosts: [],
            outboundNetworkAllowed: false,
          }),
          ok: false,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (generation === this.generation) {
          this.refreshing = false;
          this.pending = undefined;
          this.notify();
        }
      }
    })();
    return this.pending;
  }

  refreshUsage(connection: ConnectionSettings): Promise<void> {
    if (!this.fetchUsage || !this.probe?.ok || !connection.url || !connection.token) {
      return Promise.resolve();
    }
    if (this.usagePending) return this.usagePending;
    const generation = this.generation;
    this.usagePending = (async () => {
      try {
        const rows = await this.fetchUsage!(connection);
        if (generation !== this.generation || !rows || !this.probe) return;
        this.probe = { ...this.probe, managedIdentities: rows };
        this.notify();
      } catch {
        /* Keep the last chip; a usage blip should not blank the catalog. */
      } finally {
        if (generation === this.generation) this.usagePending = undefined;
      }
    })();
    return this.usagePending;
  }
}

export function connectionDiscoveryChanged(
  existing: ConnectionSettings,
  next: ConnectionSettings,
): boolean {
  return (
    existing.url.trim().replace(/\/+$/, "") !== next.url.trim().replace(/\/+$/, "") ||
    Boolean(next.token.trim() && next.token !== existing.token)
  );
}
