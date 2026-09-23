import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { listSenders, type SenderInfo } from "@napolab/texture-bridge-core";
import {
  ReceiverStoppedError,
  SenderDiscovery,
  createSharedTextureReceiver,
  type SharedTextureReceiverBridge,
} from "@napolab/texture-bridge-renderer";
import { OWN_OUTPUT_PREFIX } from "./spout-output-plan";

/** Re-exported for compatibility with existing importers. */
export { OWN_OUTPUT_PREFIX };

const DISCOVERY_INTERVAL_MS = 1000;
const MAX_ID_CHARS = 256;
/** Spout sender names are fixed 256-byte buffers. */
const MAX_SENDER_CHARS = 256;
/** First retry delay after a stopped or failed receiver; doubles per consecutive failure. */
export const NUDGE_INITIAL_MS = 3000;
export const NUDGE_MAX_MS = 60_000;
/** An open whose receiver runs this long without stopping resets the sender's backoff. */
export const NUDGE_HEALTHY_MS = 30_000;

interface ReceiverEntry {
  readonly handle: number;
  readonly senderName: string;
  readonly receiver: SharedTextureReceiverBridge;
}

function requireName(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value === "" || value.length > max) throw new Error(`invalid ${what}`);
  return value;
}

/**
 * Watches Spout senders and delivers chosen ones zero-copy into the Publisher,
 * tagged with extraArgs [sourceId]. Emits "availability" (senderName, available).
 *
 * `known` mirrors what Spout lists. When a receiver trips its circuit breaker
 * (ReceiverStoppedError), or construction fails for a sender that is still listed,
 * the sender stays in `known` (SenderDiscovery still lists it and will never
 * re-emit "added" for it). Because nothing else would ever report it available
 * again, a delayed "nudge" re-emits availability(name, true) so waiting sources
 * retry: 3 s after the first failure, doubling per consecutive failure up to 60 s.
 * The backoff resets when the sender is removed/added by discovery, or when an
 * open for it succeeds and no stop arrives within 30 s. At most one nudge is
 * pending per sender; all timers are cleared on dispose.
 */
export class SpoutInputs extends EventEmitter {
  private readonly discovery = new SenderDiscovery();
  private readonly known = new Set<string>();
  private readonly receivers = new Map<string, ReceiverEntry>();
  private started = false;
  private disposed = false;
  private nextHandle = 1;
  /** Next nudge delay per sender (absent = NUDGE_INITIAL_MS). */
  private readonly backoff = new Map<string, number>();
  private readonly nudges = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly healthy = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly target: () => WebContents | null) {
    super();
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      for (const s of listSenders()) this.known.add(s.name);
    } catch (err) {
      console.error("[hive] listSenders failed", err);
    }
    // SenderDiscovery's snapshot starts empty, so its first tick reports every
    // existing sender as "added" — harmless re-confirmation of availability.
    this.discovery.on("added", (senders: SenderInfo[]) => {
      for (const s of senders) {
        this.known.add(s.name);
        this.resetBackoff(s.name);
        this.emit("availability", s.name, true);
      }
    });
    this.discovery.on("removed", (senders: SenderInfo[]) => {
      // The discovery snapshot is already updated when "removed" fires. Senders are
      // diffed by uuid/appName, so another sender may still publish the same name.
      const still = new Set(this.discovery.getSenders().map((s) => s.name));
      for (const s of senders) {
        if (still.has(s.name) || !this.known.has(s.name)) continue;
        this.known.delete(s.name);
        this.resetBackoff(s.name);
        this.closeSender(s.name);
        this.emit("availability", s.name, false);
      }
    });
    this.discovery.on("error", (err: Error) => console.error("[hive] spout discovery", err));
    this.discovery.start(DISCOVERY_INTERVAL_MS);
  }

  /** Senders available as inputs (Hive's own outputs excluded), sorted. */
  senders(): string[] {
    return [...this.known].filter((n) => !n.startsWith(OWN_OUTPUT_PREFIX)).sort();
  }

  /**
   * Starts delivering `senderName` to the Publisher as `sourceId`, replacing any
   * receiver that source already had. Throws on invalid input, on Hive's own
   * outputs, when the Publisher is not ready, or when the sender does not exist;
   * on a throw the source's previous receiver (if any) is left untouched.
   * Returns a handle identifying this open, for `close(sourceId, handle)`.
   */
  open(sourceId: string, senderName: string): number {
    if (this.disposed) throw new Error("spout inputs disposed");
    requireName(sourceId, "sourceId", MAX_ID_CHARS);
    requireName(senderName, "sender name", MAX_SENDER_CHARS);
    if (senderName.startsWith(OWN_OUTPUT_PREFIX)) throw new Error("cannot receive Hive's own output");
    const target = this.target();
    if (!target || target.isDestroyed()) throw new Error("publisher not ready");
    // Construction is the only throwing step (e.g. no such sender); let it propagate.
    let receiver: SharedTextureReceiverBridge;
    try {
      receiver = createSharedTextureReceiver({ senderName, target, extraArgs: [sourceId] });
    } catch (err) {
      // Discovery still lists it, so no "added" will ever come; retry later ourselves.
      if (this.known.has(senderName)) this.scheduleNudge(senderName);
      throw err;
    }
    const entry: ReceiverEntry = { handle: this.nextHandle++, senderName, receiver };
    receiver.on("error", (err: Error) => {
      if (err instanceof ReceiverStoppedError) {
        // A stale receiver (sourceId since re-opened) must not tear down its successor.
        if (this.receivers.get(sourceId) !== entry) return;
        console.warn(`[hive] spout receiver ${senderName} stopped`, err);
        this.close(sourceId);
        this.clearHealthy(senderName);
        this.emit("availability", senderName, false);
        this.scheduleNudge(senderName);
      } else {
        console.warn(`[hive] spout receiver ${senderName}`, err);
      }
    });
    this.close(sourceId);
    this.receivers.set(sourceId, entry);
    receiver.start();
    this.markOpened(senderName);
    return entry.handle;
  }

  /**
   * Stops delivering `sourceId`. With a `handle`, only closes if that open is still
   * the current one, so a late close from a superseded open cannot kill its successor.
   * Without one, closes unconditionally.
   */
  close(sourceId: string, handle?: number): void {
    const entry = this.receivers.get(sourceId);
    if (!entry) return;
    if (handle !== undefined && entry.handle !== handle) return;
    this.receivers.delete(sourceId);
    entry.receiver.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.discovery.dispose(); // stops polling and removes its listeners
    for (const t of this.nudges.values()) clearTimeout(t);
    for (const t of this.healthy.values()) clearTimeout(t);
    this.nudges.clear();
    this.healthy.clear();
    this.backoff.clear();
    for (const id of [...this.receivers.keys()]) this.close(id);
    this.known.clear();
    this.removeAllListeners();
  }

  /** Re-reports a still-listed sender as available after the sender's backoff delay. */
  private scheduleNudge(senderName: string): void {
    if (this.disposed || this.nudges.has(senderName)) return;
    const delay = this.backoff.get(senderName) ?? NUDGE_INITIAL_MS;
    this.backoff.set(senderName, Math.min(delay * 2, NUDGE_MAX_MS));
    const timer = setTimeout(() => {
      this.nudges.delete(senderName);
      if (!this.disposed && this.known.has(senderName)) this.emit("availability", senderName, true);
    }, delay);
    this.nudges.set(senderName, timer);
  }

  /** Starts (or restarts) the healthy window after which the sender's backoff resets. */
  private markOpened(senderName: string): void {
    this.clearHealthy(senderName);
    const timer = setTimeout(() => {
      this.healthy.delete(senderName);
      this.backoff.delete(senderName);
    }, NUDGE_HEALTHY_MS);
    this.healthy.set(senderName, timer);
  }

  private clearHealthy(senderName: string): void {
    const t = this.healthy.get(senderName);
    if (t === undefined) return;
    clearTimeout(t);
    this.healthy.delete(senderName);
  }

  /** Discovery saw the sender come or go: forget its failure history and pending retry. */
  private resetBackoff(senderName: string): void {
    this.backoff.delete(senderName);
    this.clearHealthy(senderName);
    const t = this.nudges.get(senderName);
    if (t !== undefined) clearTimeout(t);
    this.nudges.delete(senderName);
  }

  private closeSender(senderName: string): void {
    for (const [id, entry] of [...this.receivers]) {
      if (entry.senderName === senderName) this.close(id);
    }
  }
}
