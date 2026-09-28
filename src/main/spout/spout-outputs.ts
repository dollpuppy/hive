import { createTextureBridge, type PaintDefect, type TextureBridge } from "@napolab/texture-bridge-renderer";
import type { DesiredOutput } from "./spout-output-plan";

/** Frame drops are logged at most this often per output. */
export const DROP_LOG_INTERVAL_MS = 30_000;

/** Backoff before each retry of a failed bridge; one failure more than this is reported. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/** A bridge that stays up this long earns back its full retry budget. */
export const STABLE_AFTER_MS = 30_000;

export interface SpoutOutputsOptions {
  /** Delays before successive retries (default {@link RETRY_DELAYS_MS}). */
  retryDelaysMs?: readonly number[];
  /** Uptime after which a bridge's failure count resets (default {@link STABLE_AFTER_MS}). */
  stableAfterMs?: number;
}

interface Active {
  bridge: TextureBridge;
  output: DesiredOutput;
  drops: number;
  lastDropLog: number;
  suppressedDrops: number;
  /** Resets the key's failure count once the bridge has stayed up long enough. */
  stableTimer: ReturnType<typeof setTimeout>;
}

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

const sameSpec = (a: DesiredOutput, b: DesiredOutput): boolean =>
  a.name === b.name && a.width === b.width && a.height === b.height && a.fps === b.fps && a.path === b.path;

/**
 * Keeps one texture-bridge sender per desired output. Each bridge renders the
 * local viewer page offscreen with alpha and publishes it over Spout.
 *
 * `sync()` never rejects: failures are retried, and only reported through
 * `onError` when they can't be recovered from. Teardown (`disable`/`disposeAll`)
 * never throws: `bridge.dispose()` is contract-guaranteed idempotent.
 *
 * Failures and recovery:
 * - A rejected `createTextureBridge()` is retried after each of `retryDelaysMs`
 *   (1 s, 2 s, 4 s) while the key is still wanted; the failure after the last
 *   retry goes to `onError`. A sync that drops the key cancels its retries.
 * - A running bridge is disposed and recreated, through the same backoff and
 *   budget, on its `"error"` event or when its offscreen renderer process goes
 *   away. texture-bridge 0.15.0 does not recover from either by itself:
 *   `"error"` carries a `TextureSendError` thrown by the native Spout send in
 *   the bridge's paint handler, and the bridge keeps the same sender, so a dead
 *   sender (lost device) fails every frame from then on. And the bridge never
 *   listens for `render-process-gone` on its offscreen window: a crashed
 *   renderer just stops painting — no event, no reload, the Spout output
 *   freezes on its last frame — so we watch `renderWindow.webContents` here.
 * - A resize that throws is reported directly (texture-bridge rolls the size
 *   back, so the bridge keeps running at its old size).
 *
 * Failures count against one budget per key, so a bridge that dies right after
 * every recreation is given up on too. A bridge that stays up for
 * `stableAfterMs` resets the count.
 */
export class SpoutOutputs {
  private readonly active = new Map<string, Active>();
  /** Keys with a `createTextureBridge()` call in flight. */
  private readonly pending = new Set<string>();
  /** Keys waiting out a retry backoff. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Consecutive failures per key since its last stable bridge. */
  private readonly failures = new Map<string, number>();
  /** Latest desired spec per wanted key. */
  private wanted = new Map<string, DesiredOutput>();
  private disposed = false;
  private readonly retryDelaysMs: readonly number[];
  private readonly stableAfterMs: number;

  constructor(
    private readonly baseUrl: () => string,
    private readonly onError: (key: string, error: Error) => void,
    options: SpoutOutputsOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.stableAfterMs = options.stableAfterMs ?? STABLE_AFTER_MS;
  }

  keys(): string[] {
    return [...this.active.keys()];
  }

  /**
   * `frameDropped` events seen from the output's current bridge. The bridge dedupes
   * consecutive drops with the same reason, so this counts drop episodes (a new one
   * starts after a successful send or a change of reason), not individual frames.
   */
  droppedFrames(key: string): number {
    return this.active.get(key)?.drops ?? 0;
  }

  /**
   * Converges on `desired`. Resolves once each output's first creation attempt
   * has settled; retries continue in the background.
   */
  async sync(desired: DesiredOutput[]): Promise<void> {
    if (this.disposed) return;
    this.wanted = new Map(desired.map((d) => [d.key, d]));
    for (const key of [...this.active.keys()]) {
      if (!this.wanted.has(key)) this.disable(key);
    }
    for (const key of [...this.retries.keys()]) {
      if (!this.wanted.has(key)) this.cancelRetry(key);
    }
    for (const key of [...this.failures.keys()]) {
      if (!this.wanted.has(key)) this.failures.delete(key);
    }
    await Promise.all(desired.map((d) => this.ensure(d)));
  }

  disposeAll(): void {
    this.disposed = true;
    this.wanted.clear();
    for (const key of [...this.retries.keys()]) this.cancelRetry(key);
    this.failures.clear();
    for (const key of [...this.active.keys()]) this.disable(key);
  }

  private async ensure(d: DesiredOutput): Promise<void> {
    const existing = this.active.get(d.key);
    if (existing) {
      if (existing.output.name !== d.name || existing.output.fps !== d.fps) {
        // Sender name or frame rate changed: only a fresh bridge picks it up.
        this.disable(d.key);
        await this.ensure(d);
        return;
      }
      if (existing.output.width !== d.width || existing.output.height !== d.height) {
        try {
          existing.bridge.resize(d.width, d.height);
          existing.output = d;
        } catch (err) {
          this.onError(d.key, toError(err));
        }
      }
      return;
    }
    // Creation in flight or a retry scheduled: either picks up the latest
    // spec from `wanted` once it lands or fires.
    if (this.pending.has(d.key) || this.retries.has(d.key)) return;
    await this.create(d);
  }

  /** One creation attempt. Never rejects. */
  private async create(d: DesiredOutput): Promise<void> {
    this.pending.add(d.key);
    let bridge: TextureBridge;
    try {
      bridge = await createTextureBridge({
        name: d.name,
        width: d.width,
        height: d.height,
        frameRate: d.fps,
        rendererUrl: `${this.baseUrl()}${d.path}`,
        includeAlpha: true,
        pixelExact: true,
      });
    } catch (err) {
      this.pending.delete(d.key);
      this.fail(d.key, toError(err));
      return;
    }
    this.pending.delete(d.key);
    const latest = this.wanted.get(d.key);
    if (this.disposed || !latest) {
      bridge.dispose();
      return;
    }
    const entry: Active = {
      bridge,
      output: d,
      drops: 0,
      lastDropLog: -Infinity,
      suppressedDrops: 0,
      stableTimer: setTimeout(() => {
        if (this.active.get(d.key) === entry) this.failures.delete(d.key);
      }, this.stableAfterMs),
    };
    bridge.on("error", (err: Error) => this.onRuntimeFailure(d.key, entry, err));
    bridge.on("frameDropped", (defect: PaintDefect) => this.onFrameDropped(d.key, entry, defect));
    bridge.renderWindow.webContents.on("render-process-gone", (_event, details) =>
      this.onRuntimeFailure(d.key, entry, new Error(`Spout output renderer process gone (${details.reason})`)),
    );
    this.active.set(d.key, entry);
    if (!sameSpec(latest, d)) {
      // A resize/rename arrived mid-creation; re-run ensure with the
      // latest spec so the bridge converges instead of staying stale.
      await this.ensure(latest);
    }
  }

  /** A running bridge failed: tear it down and recreate it through the retry path. */
  private onRuntimeFailure(key: string, entry: Active, error: Error): void {
    // Only the first failure of the current bridge counts; later events from a
    // bridge already torn down (or disabled) are ignored.
    if (this.active.get(key) !== entry) return;
    this.disable(key);
    this.fail(key, error);
  }

  /** Schedules a retry for a still-wanted key, or reports `error` once the budget is spent. */
  private fail(key: string, error: Error): void {
    if (this.disposed || !this.wanted.has(key)) return;
    const count = (this.failures.get(key) ?? 0) + 1;
    const delay = this.retryDelaysMs[count - 1];
    if (delay === undefined) {
      this.failures.delete(key);
      this.onError(key, error);
      return;
    }
    this.failures.set(key, count);
    this.retries.set(
      key,
      setTimeout(() => {
        this.retries.delete(key);
        const latest = this.wanted.get(key);
        if (this.disposed || !latest || this.active.has(key) || this.pending.has(key)) return;
        void this.create(latest);
      }, delay),
    );
  }

  private cancelRetry(key: string): void {
    const timer = this.retries.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.retries.delete(key);
  }

  private onFrameDropped(key: string, entry: Active, defect: PaintDefect): void {
    entry.drops += 1;
    const now = Date.now();
    if (now - entry.lastDropLog < DROP_LOG_INTERVAL_MS) {
      entry.suppressedDrops += 1;
      return;
    }
    const note = entry.suppressedDrops > 0 ? ` (${entry.suppressedDrops} more since the last report)` : "";
    entry.lastDropLog = now;
    entry.suppressedDrops = 0;
    console.warn(`[hive] spout output ${key} dropped a frame: ${defect.reason}${note}`);
  }

  private disable(key: string): void {
    const entry = this.active.get(key);
    if (!entry) return;
    this.active.delete(key);
    clearTimeout(entry.stableTimer);
    entry.bridge.dispose();
  }
}
