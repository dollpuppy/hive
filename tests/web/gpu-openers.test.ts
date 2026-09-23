import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../src/main/config/config-store";
import type { CaptureError as CaptureErrorType } from "../../src/renderer/publisher/capture-manager";

type GpuOpeners = typeof import("../../src/renderer/publisher/gpu-openers");

interface FakeStream {
  kind: string;
  track: { requestFrame: ReturnType<typeof vi.fn> };
  getVideoTracks(): unknown[];
}

function fakeStream(kind: string): FakeStream {
  const track = { requestFrame: vi.fn() };
  return { kind, track, getVideoTracks: () => [track] };
}

interface FakePacker {
  width: number;
  height: number;
  opts: unknown;
  canvas: { captureStream: ReturnType<typeof vi.fn> };
  draws: Array<{ w: number; h: number }>;
  redraws: number;
  disposed: boolean;
}

let packerInstances: FakePacker[];
let nextPackerThrows: Error | null;

vi.mock("../../src/web/alpha/alpha-packer", () => {
  class AlphaPacker implements FakePacker {
    width: number;
    height: number;
    canvas = { captureStream: vi.fn(() => fakeStream("packer-stream")) };
    draws: Array<{ w: number; h: number }> = [];
    redraws = 0;
    disposed = false;
    constructor(width: number, height: number, readonly opts: unknown) {
      if (nextPackerThrows) {
        const err = nextPackerThrows;
        nextPackerThrows = null;
        throw err;
      }
      this.width = width;
      this.height = height;
      packerInstances.push(this);
    }
    draw(_source: unknown, sw: number, sh: number): void {
      this.draws.push({ w: sw, h: sh });
    }
    redraw(): void {
      this.redraws += 1;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { AlphaPacker };
});

function fakeCanvas() {
  const ctx = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  return {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    captureStream: vi.fn(() => fakeStream("url-stream")),
    ctx,
  };
}

const spoutSource: SourceConfig = {
  id: "s1",
  name: "Spout",
  slug: "spout",
  preset: "low",
  kind: "spout",
  senderName: "OBS",
};
const urlSource: SourceConfig = {
  id: "u1",
  name: "Url",
  slug: "url",
  preset: "low",
  kind: "url",
  url: "https://example.com",
  width: 800,
  height: 600,
};
const camSource: SourceConfig = { id: "c1", name: "Cam", slug: "cam", preset: "low", kind: "webcam", deviceId: "d", deviceLabel: "Cam" };

let gpuOpeners: GpuOpeners;
let CaptureError: typeof CaptureErrorType;
let sinks: Map<string, (frame: unknown) => void>;
let unregisterFns: Map<string, ReturnType<typeof vi.fn>>;
let spoutOpen: ReturnType<typeof vi.fn>;
let spoutClose: ReturnType<typeof vi.fn>;
let urlOpen: ReturnType<typeof vi.fn>;
let urlClose: ReturnType<typeof vi.fn>;
let nowValue: number;
let lastCanvas: ReturnType<typeof fakeCanvas> | undefined;

/** Let queued promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(async () => {
  packerInstances = [];
  nextPackerThrows = null;
  sinks = new Map();
  unregisterFns = new Map();
  spoutOpen = vi.fn(async () => 7);
  spoutClose = vi.fn(async () => undefined);
  urlOpen = vi.fn(async () => 9);
  urlClose = vi.fn(async () => undefined);
  nowValue = 0;
  lastCanvas = undefined;

  vi.stubGlobal("performance", { now: () => nowValue });
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      lastCanvas = fakeCanvas();
      return lastCanvas;
    }),
  });
  vi.stubGlobal("window", {
    hiveFrames: {
      register: vi.fn((sourceId: string, sink: (frame: unknown) => void) => {
        sinks.set(sourceId, sink);
        const off = vi.fn(() => {
          if (sinks.get(sourceId) === sink) sinks.delete(sourceId);
        });
        unregisterFns.set(sourceId, off);
        return off;
      }),
    },
    hivePublisher: { spoutOpen, spoutClose, urlOpen, urlClose },
  });

  vi.resetModules();
  gpuOpeners = await import("../../src/renderer/publisher/gpu-openers");
  ({ CaptureError } = await import("../../src/renderer/publisher/capture-manager"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openSpout", () => {
  it("rejects non-spout sources", async () => {
    await expect(gpuOpeners.openSpout(camSource)).rejects.toThrow("not a spout source");
  });

  it("maps a rejected spoutOpen to CaptureError waiting, unregisters, and disposes the packer", async () => {
    spoutOpen.mockRejectedValueOnce(new Error("no sender"));
    const err = await gpuOpeners.openSpout(spoutSource).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ status: "waiting" });
    expect((err as CaptureErrorType).message).toContain('Spout sender "OBS" not found');
    expect(unregisterFns.get("s1")).toHaveBeenCalledTimes(1);
    expect(packerInstances[0]?.disposed).toBe(true);
  });

  it("wraps an AlphaPacker construction failure as CaptureError unavailable", async () => {
    nextPackerThrows = new Error("WebGL unavailable");
    const err = await gpuOpeners.openSpout(spoutSource).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ status: "unavailable" });
    expect(spoutOpen).not.toHaveBeenCalled();
  });

  it("opens successfully and dispose unregisters, closes spout, and disposes the packer", async () => {
    const capture = await gpuOpeners.openSpout(spoutSource);
    expect(spoutOpen).toHaveBeenCalledWith("s1", "OBS");
    expect(capture.stream).toMatchObject({ kind: "packer-stream" });
    expect(packerInstances[0]?.opts).toEqual({ preserveDrawingBuffer: true });
    // No frame rate: one frame per (throttled) draw.
    expect(packerInstances[0]?.canvas.captureStream).toHaveBeenCalledWith();

    capture.dispose?.();
    expect(unregisterFns.get("s1")).toHaveBeenCalledTimes(1);
    expect(spoutClose).toHaveBeenCalledWith("s1", 7);
    expect(packerInstances[0]?.disposed).toBe(true);
  });

  it("each capture closes with its own open's handle", async () => {
    spoutOpen.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const stale = await gpuOpeners.openSpout(spoutSource);
    const current = await gpuOpeners.openSpout(spoutSource);
    stale.dispose?.();
    expect(spoutClose).toHaveBeenLastCalledWith("s1", 1);
    current.dispose?.();
    expect(spoutClose).toHaveBeenLastCalledWith("s1", 2);
  });

  it("swallows a rejected spoutClose instead of letting it go unhandled", async () => {
    spoutClose.mockRejectedValueOnce(new Error("ipc down"));
    const capture = await gpuOpeners.openSpout(spoutSource);
    expect(() => capture.dispose?.()).not.toThrow();
    await flush();
    // No unhandled rejection should have been thrown by now; if it were, vitest would fail the test.
  });

  it("draws frames delivered to the registered sink through the packer", async () => {
    await gpuOpeners.openSpout(spoutSource);
    const sink = sinks.get("s1");
    expect(sink).toBeDefined();
    const frame = { displayWidth: 100, displayHeight: 50 };
    sink?.(frame);
    expect(packerInstances[0]?.draws).toEqual([{ w: 100, h: 50 }]);
  });

  it("throttles frames arriving faster than the preset fps", async () => {
    await gpuOpeners.openSpout(spoutSource); // preset "low" -> fps 30, minGap = 30ms
    const sink = sinks.get("s1");
    const frame = { displayWidth: 10, displayHeight: 10 };
    nowValue = 0;
    sink?.(frame); // first frame always draws
    nowValue = 10; // within the 30ms*0.9 gap: dropped
    sink?.(frame);
    nowValue = 40; // past the gap: draws
    sink?.(frame);
    expect(packerInstances[0]?.draws.length).toBe(2);
  });
});

describe("openUrl", () => {
  it("rejects non-url sources", async () => {
    await expect(gpuOpeners.openUrl(camSource)).rejects.toThrow("not a url source");
  });

  it("maps a rejected urlOpen to CaptureError unavailable and unregisters", async () => {
    urlOpen.mockRejectedValueOnce(new Error("load failed"));
    const err = await gpuOpeners.openUrl(urlSource).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ status: "unavailable" });
    expect((err as CaptureErrorType).message).toBe('URL source "Url" could not be opened: load failed');
    expect(unregisterFns.get("u1")).toHaveBeenCalledTimes(1);
  });

  it("opens successfully and dispose unregisters and closes the url capture", async () => {
    const capture = await gpuOpeners.openUrl(urlSource);
    expect(urlOpen).toHaveBeenCalledWith("u1");
    expect(capture.stream).toMatchObject({ kind: "url-stream" });
    expect(lastCanvas?.captureStream).toHaveBeenCalledWith();

    capture.dispose?.();
    expect(unregisterFns.get("u1")).toHaveBeenCalledTimes(1);
    expect(urlClose).toHaveBeenCalledWith("u1", 9);
  });

  it("each capture closes with its own open's handle", async () => {
    urlOpen.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const stale = await gpuOpeners.openUrl(urlSource);
    const current = await gpuOpeners.openUrl(urlSource);
    stale.dispose?.();
    expect(urlClose).toHaveBeenLastCalledWith("u1", 1);
    current.dispose?.();
    expect(urlClose).toHaveBeenLastCalledWith("u1", 2);
  });

  it("swallows a rejected urlClose instead of letting it go unhandled", async () => {
    urlClose.mockRejectedValueOnce(new Error("ipc down"));
    const capture = await gpuOpeners.openUrl(urlSource);
    expect(() => capture.dispose?.()).not.toThrow();
    await flush();
  });

  it("draws frames onto the canvas through containRect and throttles by fps", async () => {
    await gpuOpeners.openUrl(urlSource);
    const sink = sinks.get("u1");
    const canvas = lastCanvas;
    expect(canvas).toBeDefined();
    const frame = { displayWidth: 1600, displayHeight: 1200 };
    nowValue = 0;
    sink?.(frame);
    nowValue = 5; // within the throttle gap: dropped
    sink?.(frame);
    expect(canvas?.ctx.drawImage).toHaveBeenCalledTimes(1);
  });
});

describe("idle refresh", () => {
  const frame = { displayWidth: 10, displayHeight: 10 };
  const useTimers = (): void => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  };

  // Per opener: how many times its "redraw the same content" step has run so far.
  // openUrl's redraw is `ctx.drawImage(canvas, 0, 0)`, distinguished from a real frame
  // draw (`ctx.drawImage(frame, ...)`) by its first argument being the canvas itself.
  const redrawCount = {
    openSpout: () => packerInstances[0]?.redraws ?? 0,
    openUrl: () => {
      const canvas = lastCanvas;
      return canvas?.ctx.drawImage.mock.calls.filter((args: unknown[]) => args[0] === canvas).length ?? 0;
    },
  };

  for (const [name, open, source] of [
    ["openSpout", () => gpuOpeners.openSpout(spoutSource), spoutSource],
    ["openUrl", () => gpuOpeners.openUrl(urlSource), urlSource],
  ] as const) {
    describe(name, () => {
      it("re-draws the unchanged canvas and re-sends the frame each second while nothing is drawn", async () => {
        useTimers();
        const capture = await open();
        const track = (capture.stream as unknown as FakeStream).track;
        vi.advanceTimersByTime(1000);
        expect(track.requestFrame).toHaveBeenCalledTimes(1);
        expect(redrawCount[name]()).toBe(1);
        nowValue = 2000;
        vi.advanceTimersByTime(1000);
        expect(track.requestFrame).toHaveBeenCalledTimes(2);
        expect(redrawCount[name]()).toBe(2);
      });

      it("does not re-send while frames are being drawn", async () => {
        useTimers();
        const capture = await open();
        const track = (capture.stream as unknown as FakeStream).track;
        nowValue = 500;
        sinks.get(source.id)?.(frame);
        nowValue = 1000; // drew 500 ms ago
        vi.advanceTimersByTime(1000);
        expect(track.requestFrame).not.toHaveBeenCalled();
      });

      it("stops on dispose", async () => {
        useTimers();
        const capture = await open();
        const track = (capture.stream as unknown as FakeStream).track;
        capture.dispose?.();
        vi.advanceTimersByTime(5000);
        expect(track.requestFrame).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  }

  it("still re-draws (but skips requestFrame) on tracks without it", async () => {
    useTimers();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => {
        lastCanvas = fakeCanvas();
        lastCanvas.captureStream.mockReturnValue({ kind: "no-request-frame", getVideoTracks: () => [{}] } as never);
        return lastCanvas;
      }),
    });
    await gpuOpeners.openUrl(urlSource);
    vi.advanceTimersByTime(1000);
    expect(lastCanvas?.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("skips the timer entirely when the stream has no video track", async () => {
    useTimers();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => {
        lastCanvas = fakeCanvas();
        lastCanvas.captureStream.mockReturnValue({ kind: "no-track", getVideoTracks: () => [] } as never);
        return lastCanvas;
      }),
    });
    await gpuOpeners.openUrl(urlSource);
    expect(vi.getTimerCount()).toBe(0);
  });
});
