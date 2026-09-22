import { describe, expect, it } from "vitest";
import type { SourceConfig } from "../../src/main/config/config-store";
import { CaptureManager, type Capture, type Opener } from "../../src/renderer/publisher/capture-manager";

const vt: SourceConfig = { id: "v", name: "VT", slug: "vt", preset: "low", kind: "spout", senderName: "VSeeFace" };

class FakeTrack {
  stopped = false;
  contentHint = "";
  readyState: "live" | "ended" = "live";
  private listeners: (() => void)[] = [];
  stop(): void {
    this.stopped = true;
  }
  addEventListener(_: "ended", l: () => void): void {
    this.listeners.push(l);
  }
  end(): void {
    for (const l of this.listeners) l();
  }
}
const fakeStream = () => {
  const track = new FakeTrack();
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { track, stream, capture: { stream } as Capture };
};

function setup(opener?: Opener) {
  const statuses: string[] = [];
  const ended: string[] = [];
  let disposed = 0;
  const defaultOpener: Opener = async () => {
    const f = fakeStream();
    return { stream: f.stream, dispose: () => disposed++ };
  };
  const mgr = new CaptureManager({
    openers: { spout: opener ?? defaultOpener },
    onStatus: (_id, s) => statuses.push(s),
    onEnded: (id) => ended.push(id),
  });
  mgr.setSources([vt]);
  return { mgr, statuses, ended, disposed: () => disposed };
}

/** An opener whose captures the test settles by hand. */
function manualOpener() {
  const pending: { resolve: (c: Capture) => void; reject: (e: unknown) => void }[] = [];
  const opener: Opener = () => new Promise<Capture>((resolve, reject) => pending.push({ resolve, reject }));
  return { opener, pending };
}

describe("CaptureManager.setAvailability", () => {
  it("unavailable sender → waiting", () => {
    const { mgr, statuses } = setup();
    mgr.setAvailability("v", false);
    expect(statuses).toEqual(["idle", "waiting"]);
  });

  it("returning sender → idle", () => {
    const { mgr, statuses } = setup();
    mgr.setAvailability("v", false);
    mgr.setAvailability("v", true);
    expect(statuses.at(-1)).toBe("idle");
  });

  it("losing an active sender stops capture, disposes, and ends sessions", async () => {
    const { mgr, statuses, ended, disposed } = setup();
    await mgr.acquire("v");
    mgr.setAvailability("v", false);
    expect(statuses.at(-1)).toBe("waiting");
    expect(ended).toEqual(["v"]);
    expect(disposed()).toBe(1);
  });

  it("available while active leaves it live", async () => {
    const { mgr, statuses } = setup();
    await mgr.acquire("v");
    mgr.setAvailability("v", true);
    expect(statuses.at(-1)).toBe("live");
  });

  it("ignores unknown sources", () => {
    const { mgr, statuses } = setup();
    mgr.setAvailability("nope", false);
    expect(statuses).toEqual(["idle"]);
  });

  it("does not spam duplicate waiting reports on repeated same-value calls", () => {
    const { mgr, statuses } = setup();
    mgr.setAvailability("v", false);
    mgr.setAvailability("v", false);
    mgr.setAvailability("v", false);
    expect(statuses).toEqual(["idle", "waiting"]);
  });

  it("does not spam duplicate idle reports on repeated available calls", () => {
    const { mgr, statuses } = setup();
    mgr.setAvailability("v", false);
    mgr.setAvailability("v", true);
    mgr.setAvailability("v", true);
    expect(statuses).toEqual(["idle", "waiting", "idle"]);
  });

  it("unavailable during an in-flight open rejects the acquire and tears down on resolve", async () => {
    const { opener, pending } = manualOpener();
    const { mgr, statuses, ended, disposed } = setup(opener);
    const p = mgr.acquire("v");
    mgr.setAvailability("v", false);
    expect(statuses.at(-1)).toBe("waiting");
    const f = fakeStream();
    pending[0]!.resolve(f.capture);
    // manualOpener doesn't wire dispose per-call; use a capture with its own dispose.
    await expect(p).rejects.toThrow("capture stopped");
    expect(f.track.stopped).toBe(true);
    expect(statuses.at(-1)).toBe("waiting");
    expect(ended).toEqual(["v"]);
    void disposed;
  });

  it("later releases from holders of the torn-down capture don't disturb a new capture", async () => {
    const rec = (() => {
      const made: ReturnType<typeof fakeStream>[] = [];
      let disposed = 0;
      const opener: Opener = async () => {
        const f = fakeStream();
        made.push(f);
        return { stream: f.stream, dispose: () => disposed++ };
      };
      return { opener, made, disposed: () => disposed };
    })();
    const { mgr, statuses } = setup(rec.opener);
    await mgr.acquire("v");
    await mgr.acquire("v"); // two refs
    mgr.setAvailability("v", false); // both refs orphaned
    mgr.setAvailability("v", true); // back to idle
    await mgr.acquire("v"); // new capture, one ref
    mgr.release("v"); // stale: absorbed by orphan count
    expect(rec.made[1]!.track.stopped).toBe(false);
    expect(statuses.at(-1)).toBe("live");
    mgr.release("v"); // stale too
    expect(rec.made[1]!.track.stopped).toBe(false);
    expect(statuses.at(-1)).toBe("live");
    mgr.release("v"); // the real release
    expect(rec.made[1]!.track.stopped).toBe(true);
    expect(statuses.at(-1)).toBe("idle");
  });
});
