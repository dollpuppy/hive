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

interface ReceiverEntry {
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
 * (ReceiverStoppedError) the sender is reported unavailable for that source but
 * stays in `known`: SenderDiscovery still lists it and will never re-emit "added"
 * for it, so dropping it would hide a live sender from the picker until it
 * disappeared and came back. Re-opening from the picker is the recovery path.
 */
export class SpoutInputs extends EventEmitter {
  private readonly discovery = new SenderDiscovery();
  private readonly known = new Set<string>();
  private readonly receivers = new Map<string, ReceiverEntry>();
  private started = false;
  private disposed = false;

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
   */
  open(sourceId: string, senderName: string): void {
    if (this.disposed) throw new Error("spout inputs disposed");
    requireName(sourceId, "sourceId", MAX_ID_CHARS);
    requireName(senderName, "sender name", MAX_SENDER_CHARS);
    if (senderName.startsWith(OWN_OUTPUT_PREFIX)) throw new Error("cannot receive Hive's own output");
    const target = this.target();
    if (!target || target.isDestroyed()) throw new Error("publisher not ready");
    // Construction is the only throwing step (e.g. no such sender); let it propagate.
    const receiver = createSharedTextureReceiver({ senderName, target, extraArgs: [sourceId] });
    const entry: ReceiverEntry = { senderName, receiver };
    receiver.on("error", (err: Error) => {
      if (err instanceof ReceiverStoppedError) {
        // A stale receiver (sourceId since re-opened) must not tear down its successor.
        if (this.receivers.get(sourceId) !== entry) return;
        console.warn(`[hive] spout receiver ${senderName} stopped`, err);
        this.close(sourceId);
        this.emit("availability", senderName, false);
      } else {
        console.warn(`[hive] spout receiver ${senderName}`, err);
      }
    });
    this.close(sourceId);
    this.receivers.set(sourceId, entry);
    receiver.start();
  }

  close(sourceId: string): void {
    const entry = this.receivers.get(sourceId);
    if (!entry) return;
    this.receivers.delete(sourceId);
    entry.receiver.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.discovery.dispose(); // stops polling and removes its listeners
    for (const id of [...this.receivers.keys()]) this.close(id);
    this.known.clear();
    this.removeAllListeners();
  }

  private closeSender(senderName: string): void {
    for (const [id, entry] of [...this.receivers]) {
      if (entry.senderName === senderName) this.close(id);
    }
  }
}
