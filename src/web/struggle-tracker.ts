/**
 * Hysteresis for "upload struggling": true once bandwidth-limited continuously
 * for longer than `thresholdMs`; false on the first unlimited sample.
 * `sample` returns the new state only when it changes, else null.
 */
export class StruggleTracker {
  private limitedSince: number | null = null;
  private struggling = false;

  constructor(private readonly thresholdMs: number) {}

  sample(limited: boolean, now: number): boolean | null {
    if (!limited) {
      this.limitedSince = null;
      if (!this.struggling) return null;
      this.struggling = false;
      return false;
    }
    this.limitedSince ??= now;
    if (!this.struggling && now - this.limitedSince > this.thresholdMs) {
      this.struggling = true;
      return true;
    }
    return null;
  }
}
