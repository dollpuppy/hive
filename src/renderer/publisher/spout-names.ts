import type { SourceConfig } from "../../main/config/config-store";

/**
 * Spout sender names currently available, fed by availability events and seeded
 * from a spoutSenders() snapshot. The snapshot can be older than events that
 * arrive while it is in flight, so names an event touched during the fetch win
 * over the snapshot.
 */
export class SpoutNames {
  private readonly names = new Set<string>();
  private fetching = true;
  private readonly touchedDuringFetch = new Set<string>();

  has(name: string): boolean {
    return this.names.has(name);
  }

  /** Applies an availability event. */
  update(name: string, available: boolean): void {
    if (this.fetching) this.touchedDuringFetch.add(name);
    if (available) this.names.add(name);
    else this.names.delete(name);
  }

  /** Merges the fetched snapshot and ends the fetch. */
  loadSnapshot(snapshot: readonly string[]): void {
    for (const name of snapshot) {
      if (!this.touchedDuringFetch.has(name)) this.names.add(name);
    }
    this.endFetch();
  }

  /** Ends the fetch without a snapshot (it failed); events alone drive the set from now on. */
  endFetch(): void {
    this.fetching = false;
    this.touchedDuringFetch.clear();
  }
}

/** Pushes the current availability of every Spout source to `setAvailability`. */
export function applySpoutAvailability(
  sources: readonly SourceConfig[],
  names: SpoutNames,
  setAvailability: (sourceId: string, available: boolean) => void,
): void {
  for (const s of sources) {
    if (s.kind === "spout") setAvailability(s.id, names.has(s.senderName));
  }
}
