import { createTextureBridge, type PaintDefect, type TextureBridge } from "@napolab/texture-bridge-renderer";
import type { DesiredOutput } from "./spout-output-plan";

/** Frame drops are logged at most this often per output. */
export const DROP_LOG_INTERVAL_MS = 30_000;

interface Active {
  bridge: TextureBridge;
  output: DesiredOutput;
  drops: number;
  lastDropLog: number;
  suppressedDrops: number;
}

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

const sameSpec = (a: DesiredOutput, b: DesiredOutput): boolean =>
  a.name === b.name && a.width === b.width && a.height === b.height && a.fps === b.fps && a.path === b.path;

/**
 * Keeps one texture-bridge sender per desired output. Each bridge renders the
 * local viewer page offscreen with alpha and publishes it over Spout.
 *
 * `sync()` never rejects: every failure — a rejected `createTextureBridge`,
 * a throwing `resize()`, or a later `"error"` from the bridge — is reported
 * through `onError` instead. Teardown (`disable`/`disposeAll`) never throws:
 * `bridge.dispose()` is contract-guaranteed idempotent and side-effect-free
 * on failure.
 */
export class SpoutOutputs {
  private readonly active = new Map<string, Active>();
  /** Keys with a `createTextureBridge()` call in flight. */
  private readonly pending = new Set<string>();
  /** Latest desired spec for a pending key, applied once creation lands. */
  private readonly pendingLatest = new Map<string, DesiredOutput>();
  private wanted = new Set<string>();
  private disposed = false;

  constructor(
    private readonly baseUrl: () => string,
    private readonly onError: (key: string, error: Error) => void,
  ) {}

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

  async sync(desired: DesiredOutput[]): Promise<void> {
    if (this.disposed) return;
    this.wanted = new Set(desired.map((d) => d.key));
    for (const key of [...this.active.keys()]) {
      if (!this.wanted.has(key)) this.disable(key);
    }
    await Promise.all(desired.map((d) => this.ensure(d)));
  }

  disposeAll(): void {
    this.disposed = true;
    this.wanted.clear();
    this.pendingLatest.clear();
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
    if (this.pending.has(d.key)) {
      // A newer spec arrived while creation for this key is already in
      // flight; remember it so it's applied once that creation lands.
      this.pendingLatest.set(d.key, d);
      return;
    }
    this.pending.add(d.key);
    try {
      const bridge = await createTextureBridge({
        name: d.name,
        width: d.width,
        height: d.height,
        frameRate: d.fps,
        rendererUrl: `${this.baseUrl()}${d.path}`,
        includeAlpha: true,
        pixelExact: true,
      });
      this.pending.delete(d.key);
      const latest = this.pendingLatest.get(d.key);
      this.pendingLatest.delete(d.key);
      if (this.disposed || !this.wanted.has(d.key)) {
        bridge.dispose();
        return;
      }
      const entry: Active = { bridge, output: d, drops: 0, lastDropLog: -Infinity, suppressedDrops: 0 };
      bridge.on("error", (err: Error) => this.onError(d.key, err));
      bridge.on("frameDropped", (defect: PaintDefect) => this.onFrameDropped(d.key, entry, defect));
      this.active.set(d.key, entry);
      if (latest && !sameSpec(latest, d)) {
        // A resize/rename arrived mid-creation; re-run ensure with the
        // latest spec so the bridge converges instead of staying stale.
        await this.ensure(latest);
      }
    } catch (err) {
      this.pending.delete(d.key);
      this.pendingLatest.delete(d.key);
      this.onError(d.key, toError(err));
    }
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
    entry.bridge.dispose();
  }
}
