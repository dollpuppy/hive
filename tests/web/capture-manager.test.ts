import { describe, expect, it } from "vitest";
import type { SourceConfig } from "../../src/main/config/config-store";
import { CaptureError, CaptureManager, type Capture, type Opener } from "../../src/renderer/publisher/capture-manager";

class FakeTrack {
  stopped = false;
  contentHint = "";
  readyState: "live" | "ended" = "live";
  private listeners: (() => void)[] = [];
  stop(): void { this.stopped = true; }
  addEventListener(_: "ended", l: () => void): void { this.listeners.push(l); }
  end(): void { for (const l of this.listeners) l(); }
}
const fakeStream = () => {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { track, stream, capture: { stream } as Capture };
};

const game: SourceConfig = { id: "g", name: "Game", slug: "game", preset: "med", kind: "window", windowTitle: "melonDS" };

function setup(opener: Opener) {
  const statuses: [string, string][] = [];
  const ended: string[] = [];
  const mgr = new CaptureManager({
    openers: { window: opener },
    onStatus: (id, s) => statuses.push([id, s]),
    onEnded: (id) => ended.push(id),
  });
  mgr.setSources([game]);
  return { mgr, statuses, ended };
}

/** An opener whose captures the test settles by hand. */
function manualOpener() {
  const pending: { source: SourceConfig; resolve: (c: Capture) => void; reject: (e: unknown) => void }[] = [];
  const opener: Opener = (source) =>
    new Promise<Capture>((resolve, reject) => pending.push({ source, resolve, reject }));
  return { opener, pending };
}

/** Opener that hands out a fresh fake stream per open and records what it opened. */
function recordingOpener() {
  const made: ReturnType<typeof fakeStream>[] = [];
  const sources: SourceConfig[] = [];
  let disposed = 0;
  const opener: Opener = async (source) => {
    const f = fakeStream();
    made.push(f);
    sources.push(source);
    return { stream: f.stream, dispose: () => disposed++ };
  };
  return { opener, made, sources, disposed: () => disposed };
}

describe("CaptureManager", () => {
  it("reports idle for new sources", () => {
    const { statuses } = setup(async () => fakeStream().capture);
    expect(statuses).toEqual([["g", "idle"]]);
  });

  it("opens once for many subscribers and stops at zero refs", async () => {
    const made: FakeTrack[] = [];
    let opens = 0;
    const { mgr, statuses } = setup(async () => {
      opens++;
      const f = fakeStream();
      made.push(f.track);
      return f.capture;
    });
    const [a, b] = await Promise.all([mgr.acquire("g"), mgr.acquire("g")]);
    expect(a).toBe(b);
    expect(opens).toBe(1);
    expect(statuses.at(-1)).toEqual(["g", "live"]);
    expect(made[0]!.contentHint).toBe("detail");
    mgr.release("g");
    expect(made[0]!.stopped).toBe(false);
    mgr.release("g");
    expect(made[0]!.stopped).toBe(true);
    expect(statuses.at(-1)).toEqual(["g", "idle"]);
  });

  it("marks unavailable when the opener fails and rethrows", async () => {
    const { mgr, statuses } = setup(async () => {
      throw new CaptureError("unavailable", "window not found");
    });
    await expect(mgr.acquire("g")).rejects.toThrow("window not found");
    expect(statuses.at(-1)).toEqual(["g", "unavailable"]);
  });

  it("rejects every concurrent waiter on failure and forgets the entry", async () => {
    const { opener, pending } = manualOpener();
    const { mgr, statuses } = setup(opener);
    const a = mgr.acquire("g");
    const b = mgr.acquire("g");
    pending[0]!.reject(new CaptureError("unavailable", "window not found"));
    await expect(a).rejects.toThrow("window not found");
    await expect(b).rejects.toThrow("window not found");
    // The failed entry is gone: the next acquire opens again, holding exactly one ref.
    const c = mgr.acquire("g");
    expect(pending).toHaveLength(2);
    const f = fakeStream();
    pending[1]!.resolve(f.capture);
    await c;
    expect(statuses.at(-1)).toEqual(["g", "live"]);
    mgr.release("g");
    expect(f.track.stopped).toBe(true);
  });

  it("uses the CaptureError status on failure", async () => {
    const { mgr, statuses } = setup(async () => {
      throw new CaptureError("waiting", "no sender yet");
    });
    await expect(mgr.acquire("g")).rejects.toThrow("no sender yet");
    expect(statuses.at(-1)).toEqual(["g", "waiting"]);
  });

  it("track ending marks unavailable and notifies", async () => {
    const f = fakeStream();
    const { mgr, statuses, ended } = setup(async () => f.capture);
    await mgr.acquire("g");
    f.track.end();
    expect(statuses.at(-1)).toEqual(["g", "unavailable"]);
    expect(ended).toEqual(["g"]);
  });

  it("fails the open when the track has already ended", async () => {
    const rec = recordingOpener();
    let deadOnArrival = true;
    const { mgr, statuses, ended } = setup(async (source) => {
      const c = await rec.opener(source);
      if (deadOnArrival) rec.made.at(-1)!.track.readyState = "ended";
      return c;
    });
    const a = mgr.acquire("g");
    const b = mgr.acquire("g");
    await expect(a).rejects.toThrow("capture ended");
    await expect(b).rejects.toThrow("capture ended");
    expect(statuses.at(-1)).toEqual(["g", "unavailable"]);
    expect(statuses.some(([, s]) => s === "live")).toBe(false);
    expect(ended).toEqual([]);
    expect(rec.made[0]!.track.stopped).toBe(true);
    expect(rec.disposed()).toBe(1);
    // No refs were orphaned: a fresh capture stops on its own single release.
    deadOnArrival = false;
    await mgr.acquire("g");
    mgr.release("g");
    expect(rec.made[1]!.track.stopped).toBe(true);
  });

  it("acquire after a track ended re-opens a fresh capture", async () => {
    const rec = recordingOpener();
    const { mgr } = setup(rec.opener);
    const first = await mgr.acquire("g");
    rec.made[0]!.track.end();
    expect(rec.disposed()).toBe(1);
    const second = await mgr.acquire("g");
    expect(rec.made).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  it("removing a source stops its capture", async () => {
    const f = fakeStream();
    const { mgr } = setup(async () => f.capture);
    await mgr.acquire("g");
    mgr.setSources([]);
    expect(f.track.stopped).toBe(true);
  });

  it("removing an active source ends its sessions and disposes", async () => {
    const rec = recordingOpener();
    const { mgr, ended } = setup(rec.opener);
    await mgr.acquire("g");
    mgr.setSources([]);
    expect(ended).toEqual(["g"]);
    expect(rec.disposed()).toBe(1);
  });

  it("rejects unknown sources and kinds without an opener", async () => {
    const { mgr } = setup(async () => fakeStream().capture);
    await expect(mgr.acquire("nope")).rejects.toThrow("unknown source");
    mgr.setSources([{ id: "w", name: "Cam", slug: "cam", preset: "low", kind: "webcam", deviceId: "d", deviceLabel: "C" }]);
    await expect(mgr.acquire("w")).rejects.toThrow("no opener for webcam");
  });

  it("calls dispose on a normal stop", async () => {
    const rec = recordingOpener();
    const { mgr } = setup(rec.opener);
    await mgr.acquire("g");
    mgr.release("g");
    expect(rec.made[0]!.track.stopped).toBe(true);
    expect(rec.disposed()).toBe(1);
  });

  it("releasing the last ref while opening tears the capture down when it arrives", async () => {
    const { opener, pending } = manualOpener();
    const { mgr, statuses } = setup(opener);
    const p = mgr.acquire("g");
    mgr.release("g");
    expect(statuses.at(-1)).toEqual(["g", "idle"]);
    const f = fakeStream();
    let disposed = false;
    pending[0]!.resolve({ stream: f.stream, dispose: () => (disposed = true) });
    await expect(p).rejects.toThrow("capture stopped");
    expect(f.track.stopped).toBe(true);
    expect(disposed).toBe(true);
    expect(statuses.at(-1)).toEqual(["g", "idle"]);
    expect(statuses.some(([, s]) => s === "live")).toBe(false);
  });

  it("an opener failing after its entry was stopped reports nothing", async () => {
    const { opener, pending } = manualOpener();
    const { mgr, statuses } = setup(opener);
    const p = mgr.acquire("g");
    mgr.release("g");
    pending[0]!.reject(new CaptureError("unavailable", "gone"));
    await expect(p).rejects.toThrow("gone");
    expect(statuses.at(-1)).toEqual(["g", "idle"]);
  });

  describe("config changes", () => {
    it("keeps capturing through cosmetic changes (name/slug)", async () => {
      const rec = recordingOpener();
      const { mgr, ended } = setup(rec.opener);
      await mgr.acquire("g");
      mgr.setSources([{ ...game, name: "Renamed", slug: "renamed" }]);
      expect(rec.made[0]!.track.stopped).toBe(false);
      expect(ended).toEqual([]);
    });

    it("stops a live capture whose capture config changed, ends sessions, reports idle", async () => {
      const rec = recordingOpener();
      const { mgr, statuses, ended } = setup(rec.opener);
      await mgr.acquire("g");
      mgr.setSources([{ ...game, windowTitle: "Dolphin" }]);
      expect(rec.made[0]!.track.stopped).toBe(true);
      expect(rec.disposed()).toBe(1);
      expect(ended).toEqual(["g"]);
      expect(statuses.at(-1)).toEqual(["g", "idle"]);
      await mgr.acquire("g");
      expect(rec.sources.at(-1)).toMatchObject({ windowTitle: "Dolphin" });
    });

    it("treats a preset change as a capture change", async () => {
      const rec = recordingOpener();
      const { mgr, ended } = setup(rec.opener);
      await mgr.acquire("g");
      mgr.setSources([{ ...game, preset: "high" }]);
      expect(ended).toEqual(["g"]);
      await mgr.acquire("g");
      expect(rec.sources.at(-1)).toMatchObject({ preset: "high" });
    });

    it("rejects waiters of a capture that was still opening", async () => {
      const { opener, pending } = manualOpener();
      const { mgr, statuses } = setup(opener);
      const p = mgr.acquire("g");
      mgr.setSources([{ ...game, windowTitle: "Dolphin" }]);
      const f = fakeStream();
      pending[0]!.resolve(f.capture);
      await expect(p).rejects.toThrow("capture stopped");
      expect(f.track.stopped).toBe(true);
      expect(statuses.some(([, s]) => s === "live")).toBe(false);
    });
  });

  describe("unavailable recovery", () => {
    it("re-sending the sources resets an unavailable source to idle", async () => {
      const { mgr, statuses } = setup(async () => {
        throw new CaptureError("unavailable", "window not found");
      });
      await expect(mgr.acquire("g")).rejects.toThrow();
      mgr.setSources([game]);
      expect(statuses.at(-1)).toEqual(["g", "idle"]);
    });

    it("resets a source whose track ended", async () => {
      const rec = recordingOpener();
      const { mgr, statuses } = setup(rec.opener);
      await mgr.acquire("g");
      rec.made[0]!.track.end();
      expect(statuses.at(-1)).toEqual(["g", "unavailable"]);
      mgr.setSources([game]);
      expect(statuses.at(-1)).toEqual(["g", "idle"]);
    });

    it("leaves idle, live and waiting sources alone", async () => {
      const rec = recordingOpener();
      const { mgr, statuses } = setup(rec.opener);
      mgr.setSources([game]);
      expect(statuses).toEqual([["g", "idle"]]);
      await mgr.acquire("g");
      const n = statuses.length;
      mgr.setSources([game]);
      expect(statuses.length).toBe(n);

      const waiting = setup(async () => {
        throw new CaptureError("waiting", "no sender yet");
      });
      await expect(waiting.mgr.acquire("g")).rejects.toThrow();
      waiting.mgr.setSources([game]);
      expect(waiting.statuses.at(-1)).toEqual(["g", "waiting"]);
    });

    it("does not reset a source that is opening again", async () => {
      const { opener, pending } = manualOpener();
      const { mgr, statuses } = setup(opener);
      const a = mgr.acquire("g");
      pending[0]!.reject(new CaptureError("unavailable", "gone"));
      await expect(a).rejects.toThrow();
      void mgr.acquire("g"); // opening, still reported unavailable
      mgr.setSources([game]);
      expect(statuses.at(-1)).toEqual(["g", "unavailable"]);
    });

    it("forgets the status of a removed source", async () => {
      const { mgr, statuses } = setup(async () => {
        throw new CaptureError("unavailable", "window not found");
      });
      await expect(mgr.acquire("g")).rejects.toThrow();
      mgr.setSources([]);
      mgr.setSources([game]);
      expect(statuses.at(-1)).toEqual(["g", "idle"]);
      expect(statuses.filter(([, s]) => s === "idle")).toHaveLength(2);
    });
  });

  describe("stale releases", () => {
    it("absorbs releases from sessions of a capture that already ended", async () => {
      const rec = recordingOpener();
      const { mgr, statuses } = setup(rec.opener);
      await mgr.acquire("g");
      await mgr.acquire("g");
      rec.made[0]!.track.end(); // two refs orphaned
      await mgr.acquire("g"); // new capture, one ref
      mgr.release("g");
      mgr.release("g");
      expect(rec.made[1]!.track.stopped).toBe(false);
      expect(statuses.at(-1)).toEqual(["g", "live"]);
      mgr.release("g");
      expect(rec.made[1]!.track.stopped).toBe(true);
      expect(statuses.at(-1)).toEqual(["g", "idle"]);
    });

    it("absorbs releases made synchronously from onEnded", async () => {
      const rec = recordingOpener();
      const statuses: string[] = [];
      const mgr: CaptureManager = new CaptureManager({
        openers: { window: rec.opener },
        onStatus: (_, s) => statuses.push(s),
        onEnded: (id) => {
          mgr.release(id);
          mgr.release(id);
        },
      });
      mgr.setSources([game]);
      await mgr.acquire("g");
      await mgr.acquire("g");
      rec.made[0]!.track.end();
      expect(statuses.at(-1)).toBe("unavailable");
      await mgr.acquire("g");
      expect(rec.made[1]!.track.stopped).toBe(false);
      mgr.release("g");
      expect(rec.made[1]!.track.stopped).toBe(true);
    });

    it("absorbs releases after a config-change restart", async () => {
      const rec = recordingOpener();
      const { mgr } = setup(rec.opener);
      await mgr.acquire("g");
      mgr.setSources([{ ...game, windowTitle: "Dolphin" }]);
      await mgr.acquire("g");
      mgr.release("g"); // stale: belongs to the old capture
      expect(rec.made[1]!.track.stopped).toBe(false);
      mgr.release("g");
      expect(rec.made[1]!.track.stopped).toBe(true);
    });

    it("does not orphan refs of waiters whose open was rejected", async () => {
      const { opener, pending } = manualOpener();
      const { mgr } = setup(opener);
      const p = mgr.acquire("g");
      mgr.setSources([{ ...game, windowTitle: "Dolphin" }]);
      pending[0]!.resolve(fakeStream().capture);
      await expect(p).rejects.toThrow();
      const next = mgr.acquire("g");
      const f = fakeStream();
      pending[1]!.resolve(f.capture);
      await next;
      mgr.release("g");
      expect(f.track.stopped).toBe(true);
    });

    it("ignores releases with nothing to release", () => {
      const { mgr, statuses } = setup(async () => fakeStream().capture);
      mgr.release("g");
      mgr.release("nope");
      expect(statuses).toEqual([["g", "idle"]]);
    });
  });
});
