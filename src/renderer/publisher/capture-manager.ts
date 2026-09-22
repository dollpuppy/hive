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

  constructor(private readonly opts: CaptureManagerOptions) {}

  setSources(sources: SourceConfig[]): void {
    const prev = this.sources;
    this.sources = new Map(sources.map((s) => [s.id, s]));
    for (const s of sources) {
      if (!prev.has(s.id)) this.opts.onStatus(s.id, "idle");
    }
    for (const [id, entry] of [...this.active]) {
      const next = this.sources.get(id);
      if (next && captureKey(next) === captureKey(entry.source)) continue;
      // Removed, or reconfigured: stop now so the next subscriber opens the new config.
      this.teardown(id, entry);
      this.opts.onEnded(id);
      if (next) this.opts.onStatus(id, "idle");
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
        entry.resolved = capture;
        const track = stream.getVideoTracks()[0];
        if (track) {
          track.contentHint = contentHintFor(source.kind);
          track.addEventListener("ended", () => this.onTrackEnded(sourceId, entry));
        }
        this.opts.onStatus(sourceId, "live");
        return stream;
      },
      (err: unknown) => {
        if (!entry.stopped) {
          entry.stopped = true;
          if (this.active.get(sourceId) === entry) this.active.delete(sourceId);
          this.opts.onStatus(sourceId, err instanceof CaptureError ? err.status : "unavailable");
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
    if (this.sources.has(sourceId)) this.opts.onStatus(sourceId, "idle");
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
    this.opts.onStatus(sourceId, "unavailable");
    this.opts.onEnded(sourceId);
  }
}
