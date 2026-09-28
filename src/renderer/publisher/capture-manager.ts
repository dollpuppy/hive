import type { SourceConfig } from "../../main/config/config-store";
import { contentHintFor } from "../../shared/presets";
import type { SourceKind, SourceStatus } from "../../shared/protocol";

export class CaptureError extends Error {
  constructor(readonly status: Extract<SourceStatus, "unavailable" | "waiting">, message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

/** An open capture. `dispose` releases non-track resources (Spout receivers, offscreen windows). */
export interface Capture {
  stream: MediaStream;
  dispose?(): void;
  /**
   * Registers the manager's "this capture died" callback, for producers whose death
   * the video track can't signal (stopping a track locally never fires its own
   * `ended`). Treated exactly like the track ending. May call `listener` right away
   * if the capture already died.
   */
  onEnded?(listener: () => void): void;
}

export type Opener = (source: SourceConfig) => Promise<Capture>;

export interface CaptureManagerOptions {
  openers: Partial<Record<SourceKind, Opener>>;
  onStatus(sourceId: string, status: SourceStatus): void;
  /** The capture died or was torn down under its subscribers: end their sessions. */
  onEnded(sourceId: string): void;
}

interface Active {
  /** The config this capture was opened with. */
  source: SourceConfig;
  refs: number;
  stream: Promise<MediaStream>;
  /** Set once the opener resolves, so teardown can be synchronous. */
  resolved: Capture | null;
  stopped: boolean;
}

/** Fields that change what is captured (everything but the display name and slug). */
function captureKey(source: SourceConfig): string {
  const { name: _name, slug: _slug, ...rest } = source;
  const fields = rest as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((k) => [k, fields[k]]),
  );
}

/**
 * Ref-counted captures: a source is opened on the first acquire and stopped when the
 * last holder releases it.
 *
 * Releases are keyed by source id only, so a capture torn down while holders still
 * have refs (track ended, source removed or reconfigured) leaves those refs
 * "orphaned": the holders will still call release() later. The orphan count per id
 * absorbs that many releases before any release touches a newer capture of the same
 * source. Absorbing first can only keep a newer capture alive a little longer, never
 * stop it early, since the total number of releases always matches the refs handed out.
 *
 * A capture torn down while still opening rejects its waiters with "capture stopped";
 * a rejected acquire is never released, so such waiters are not counted as orphans.
 */
export class CaptureManager {
  private sources = new Map<string, SourceConfig>();
  private readonly active = new Map<string, Active>();
  private readonly orphans = new Map<string, number>();
  /** The last status reported per source. */
  private readonly statuses = new Map<string, SourceStatus>();

  constructor(private readonly opts: CaptureManagerOptions) {}

  /**
   * Replace the source list. New sources report idle. A source that is unavailable
   * and not open is reset to idle too, so re-sending the list (e.g. after the user
   * re-picks the same window or device) lets the next subscriber try again.
   * `waiting` is left alone: `setAvailability` owns that transition.
   */
  setSources(sources: SourceConfig[]): void {
    const prev = this.sources;
    this.sources = new Map(sources.map((s) => [s.id, s]));
    for (const id of [...this.statuses.keys()]) {
      if (!this.sources.has(id)) this.statuses.delete(id);
    }
    for (const s of sources) {
      if (!prev.has(s.id)) this.report(s.id, "idle");
      else if (this.statuses.get(s.id) === "unavailable" && !this.active.has(s.id)) this.report(s.id, "idle");
    }
    for (const [id, entry] of [...this.active]) {
      const next = this.sources.get(id);
      if (next && captureKey(next) === captureKey(entry.source)) continue;
      // Removed, or reconfigured: stop now so the next subscriber opens the new config.
      this.teardown(id, entry);
      this.opts.onEnded(id);
      if (next) this.report(id, "idle");
    }
  }

  acquire(sourceId: string): Promise<MediaStream> {
    const existing = this.active.get(sourceId);
    if (existing) {
      existing.refs++;
      return existing.stream;
    }
    const source = this.sources.get(sourceId);
    if (!source) return Promise.reject(new Error(`unknown source ${sourceId}`));
    const opener = this.opts.openers[source.kind];
    if (!opener) return Promise.reject(new CaptureError("unavailable", `no opener for ${source.kind}`));

    const entry: Active = { source, refs: 1, stream: Promise.resolve(null as never), resolved: null, stopped: false };
    entry.stream = opener(source).then(
      (capture) => {
        const { stream } = capture;
        if (entry.stopped) {
          stream.getTracks().forEach((t) => t.stop());
          capture.dispose?.();
          throw new Error("capture stopped");
        }
        const track = stream.getVideoTracks()[0];
        if (track) {
          track.contentHint = contentHintFor(source.kind);
          track.addEventListener("ended", () => this.onTrackEnded(sourceId, entry));
        }
        // A producer-side death reported while still registering counts as "ended as it opened".
        let registering = true;
        let endedEarly = false;
        capture.onEnded?.(() => {
          if (registering) endedEarly = true;
          else this.onTrackEnded(sourceId, entry);
        });
        registering = false;
        if (track?.readyState === "ended" || endedEarly) {
          // Died before we could listen ("ended" never fires for it). Nobody holds this
          // stream yet, so fail the open like an opener error: waiters reject, no release follows.
          entry.stopped = true;
          if (this.active.get(sourceId) === entry) this.active.delete(sourceId);
          stream.getTracks().forEach((t) => t.stop());
          capture.dispose?.();
          this.report(sourceId, "unavailable");
          throw new CaptureError("unavailable", "capture ended as it opened");
        }
        entry.resolved = capture;
        this.report(sourceId, "live");
        return stream;
      },
      (err: unknown) => {
        if (!entry.stopped) {
          entry.stopped = true;
          if (this.active.get(sourceId) === entry) this.active.delete(sourceId);
          this.report(sourceId, err instanceof CaptureError ? err.status : "unavailable");
        }
        throw err;
      },
    );
    this.active.set(sourceId, entry);
    return entry.stream;
  }

  release(sourceId: string): void {
    const orphaned = this.orphans.get(sourceId) ?? 0;
    if (orphaned > 0) {
      if (orphaned === 1) this.orphans.delete(sourceId);
      else this.orphans.set(sourceId, orphaned - 1);
      return;
    }
    const entry = this.active.get(sourceId);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.teardown(sourceId, entry);
    if (this.sources.has(sourceId)) this.report(sourceId, "idle");
  }

  /**
   * A Spout sender appeared or disappeared (source id already mapped from sender name
   * by the caller). Unavailable: report `waiting`, tearing down and ending sessions if
   * the source was open or still opening - same fate as a config change or a dying
   * track. Available: only a source parked in `waiting` moves, back to `idle`, so the
   * next subscriber can try again. Repeated calls with the same value are a no-op past
   * the first, since `applySources` re-reports availability on every sync.
   */
  setAvailability(sourceId: string, available: boolean): void {
    if (!this.sources.has(sourceId)) return;
    if (available) {
      if (this.statuses.get(sourceId) === "waiting" && !this.active.has(sourceId)) {
        this.report(sourceId, "idle");
      }
      return;
    }
    const entry = this.active.get(sourceId);
    if (entry) {
      this.teardown(sourceId, entry);
      this.report(sourceId, "waiting");
      this.opts.onEnded(sourceId);
      return;
    }
    if (this.statuses.get(sourceId) === "waiting") return;
    this.report(sourceId, "waiting");
  }

  private report(sourceId: string, status: SourceStatus): void {
    if (this.sources.has(sourceId)) this.statuses.set(sourceId, status);
    this.opts.onStatus(sourceId, status);
  }

  private teardown(sourceId: string, entry: Active): void {
    if (this.active.get(sourceId) === entry) this.active.delete(sourceId);
    entry.stopped = true;
    const capture = entry.resolved;
    if (!capture) return; // still opening: the open handler stops it and rejects the waiters
    if (entry.refs > 0) this.orphans.set(sourceId, (this.orphans.get(sourceId) ?? 0) + entry.refs);
    entry.refs = 0;
    capture.stream.getTracks().forEach((t) => t.stop());
    capture.dispose?.();
  }

  private onTrackEnded(sourceId: string, entry: Active): void {
    if (this.active.get(sourceId) !== entry) return;
    this.teardown(sourceId, entry);
    this.report(sourceId, "unavailable");
    this.opts.onEnded(sourceId);
  }
}
