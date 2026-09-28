import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesiredOutput } from "../../src/main/spout/spout-output-plan";

const h = vi.hoisted(() => {
  const state = {
    // Each entry: resolves the next createTextureBridge() call (FIFO), or
    // rejects when `reject` is set.
    creates: [] as { resolve: (bridge: unknown) => void; reject: (err: unknown) => void }[],
    bridges: [] as unknown[],
    calls: [] as { name: string; width: number; height: number; frameRate: number; rendererUrl: string }[],
  };
  return { state };
});

vi.mock("@napolab/texture-bridge-renderer", () => {
  return {
    createTextureBridge: vi.fn((options: { name: string; width: number; height: number; frameRate: number; rendererUrl: string }) => {
      h.state.calls.push(options);
      return new Promise((resolve, reject) => {
        h.state.creates.push({ resolve, reject });
      });
    }),
  };
});

class FakeBridge extends EventEmitter {
  renderWindow = { webContents: new EventEmitter() };
  resizeCalls: { width: number; height: number }[] = [];
  disposed = false;
  resizeThrows: Error | null = null;

  resize(width: number, height: number): void {
    this.resizeCalls.push({ width, height });
    if (this.resizeThrows) throw this.resizeThrows;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function output(overrides: Partial<DesiredOutput> = {}): DesiredOutput {
  return {
    key: "p/s",
    name: "Hive - Partner - Source",
    path: "/s/p/s",
    width: 1280,
    height: 720,
    fps: 30,
    ...overrides,
  };
}

/** Resolves the create call at `index` (0-based, in call order) with a fresh FakeBridge. */
function resolveCreate(index: number): FakeBridge {
  const bridge = new FakeBridge();
  h.state.bridges.push(bridge);
  const entry = h.state.creates[index];
  if (!entry) throw new Error(`no pending create at index ${index}`);
  entry.resolve(bridge);
  return bridge;
}

function rejectCreate(index: number, err: unknown): void {
  const entry = h.state.creates[index];
  if (!entry) throw new Error(`no pending create at index ${index}`);
  entry.reject(err);
}

/** Flush microtasks so pending promise resolutions/rejections settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let SpoutOutputs: typeof import("../../src/main/spout/spout-outputs").SpoutOutputs;
let STABLE_AFTER_MS: number;
let errors: [string, Error][];
let outputs: InstanceType<typeof SpoutOutputs>;

beforeEach(async () => {
  h.state.creates = [];
  h.state.bridges = [];
  h.state.calls = [];
  ({ SpoutOutputs, STABLE_AFTER_MS } = await import("../../src/main/spout/spout-outputs"));
  errors = [];
  outputs = new SpoutOutputs(
    () => "http://127.0.0.1:1234",
    (key, err) => errors.push([key, err]),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SpoutOutputs", () => {
  it("creates a bridge for a new desired output", async () => {
    const p = outputs.sync([output()]);
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0]).toEqual({
      name: "Hive - Partner - Source",
      width: 1280,
      height: 720,
      frameRate: 30,
      rendererUrl: "http://127.0.0.1:1234/s/p/s",
      includeAlpha: true,
      pixelExact: true,
    });
    resolveCreate(0);
    await p;
    expect(outputs.keys()).toEqual(["p/s"]);
  });

  it("disposes a bridge no longer wanted", async () => {
    await Promise.all([outputs.sync([output()]), (async () => resolveCreate(0))()]);
    await outputs.sync([]);
    expect(outputs.keys()).toEqual([]);
    expect((h.state.bridges[0] as FakeBridge).disposed).toBe(true);
  });

  it("resizes in place when only size changes", async () => {
    await Promise.all([outputs.sync([output()]), (async () => resolveCreate(0))()]);
    await outputs.sync([output({ width: 1920, height: 1080 })]);
    const bridge = h.state.bridges[0] as FakeBridge;
    expect(bridge.resizeCalls).toEqual([{ width: 1920, height: 1080 }]);
    expect(bridge.disposed).toBe(false);
    expect(h.state.calls).toHaveLength(1);
  });

  it("recreates the bridge when the sender name changes", async () => {
    await Promise.all([outputs.sync([output()]), (async () => resolveCreate(0))()]);
    const first = h.state.bridges[0] as FakeBridge;
    const p = outputs.sync([output({ name: "Hive - Partner - Renamed" })]);
    resolveCreate(1);
    await p;
    expect(first.disposed).toBe(true);
    expect(h.state.calls).toHaveLength(2);
    expect(h.state.calls[1]?.name).toBe("Hive - Partner - Renamed");
  });

  it("recreates the bridge when fps changes", async () => {
    await Promise.all([outputs.sync([output()]), (async () => resolveCreate(0))()]);
    const first = h.state.bridges[0] as FakeBridge;
    const p = outputs.sync([output({ fps: 60 })]);
    resolveCreate(1);
    await p;
    expect(first.disposed).toBe(true);
    expect(h.state.calls).toHaveLength(2);
  });

  it("disposes a bridge that finishes creating after becoming unwanted", async () => {
    const p1 = outputs.sync([output()]);
    const p2 = outputs.sync([]);
    resolveCreate(0);
    await Promise.all([p1, p2]);
    expect(outputs.keys()).toEqual([]);
    expect((h.state.bridges[0] as FakeBridge).disposed).toBe(true);
  });

  it("disposeAll during a pending create disposes it once it lands, and later sync is a no-op", async () => {
    const p = outputs.sync([output()]);
    outputs.disposeAll();
    resolveCreate(0);
    await p;
    expect((h.state.bridges[0] as FakeBridge).disposed).toBe(true);
    // sync() after disposeAll must not resurrect anything.
    await outputs.sync([output()]);
    expect(h.state.calls).toHaveLength(1);
    expect(outputs.keys()).toEqual([]);
  });

  it("applies the latest desired spec after a pending create lands", async () => {
    const p1 = outputs.sync([output({ width: 1280, height: 720 })]);
    // A resize arrives while the first create is still in flight.
    const p2 = outputs.sync([output({ width: 1920, height: 1080 })]);
    const bridge = resolveCreate(0);
    await Promise.all([p1, p2]);
    // Only one bridge was created (for the original spec); the latest spec
    // (a size-only change) is applied via resize once creation lands.
    expect(h.state.calls).toHaveLength(1);
    expect(bridge.resizeCalls).toEqual([{ width: 1920, height: 1080 }]);
  });

  it("reports onError when resize throws, without disposing the bridge", async () => {
    await Promise.all([outputs.sync([output()]), (async () => resolveCreate(0))()]);
    const bridge = h.state.bridges[0] as FakeBridge;
    bridge.resizeThrows = new Error("resize failed");
    await outputs.sync([output({ width: 640, height: 480 })]);
    expect(errors).toEqual([["p/s", bridge.resizeThrows]]);
    expect(bridge.disposed).toBe(false);
    expect(outputs.keys()).toEqual(["p/s"]);
  });

  it("sync never rejects when create rejects, and nothing is reported before the retries run out", async () => {
    vi.useFakeTimers();
    const p = outputs.sync([output()]);
    rejectCreate(0, new Error("no device"));
    await expect(p).resolves.toBeUndefined();
    expect(errors).toEqual([]);
    expect(outputs.keys()).toEqual([]);
  });

  describe("create retry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("retries a rejected create after 1 s, 2 s and 4 s, then reports the last error", async () => {
      void outputs.sync([output()]);
      rejectCreate(0, new Error("fail 1"));
      await vi.advanceTimersByTimeAsync(999);
      expect(h.state.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state.calls).toHaveLength(2);
      rejectCreate(1, new Error("fail 2"));
      await vi.advanceTimersByTimeAsync(1999);
      expect(h.state.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state.calls).toHaveLength(3);
      rejectCreate(2, new Error("fail 3"));
      await vi.advanceTimersByTimeAsync(3999);
      expect(h.state.calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state.calls).toHaveLength(4);
      expect(errors).toEqual([]);
      const last = new Error("fail 4");
      rejectCreate(3, last);
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toEqual([["p/s", last]]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.state.calls).toHaveLength(4);
      expect(outputs.keys()).toEqual([]);
    });

    it("keeps a bridge whose retry succeeds, without reporting an error", async () => {
      void outputs.sync([output()]);
      rejectCreate(0, new Error("fail 1"));
      await vi.advanceTimersByTimeAsync(1000);
      resolveCreate(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(outputs.keys()).toEqual(["p/s"]);
      expect(errors).toEqual([]);
    });

    it("honors injected retry delays", async () => {
      outputs = new SpoutOutputs(
        () => "http://127.0.0.1:1234",
        (key, err) => errors.push([key, err]),
        { retryDelaysMs: [10] },
      );
      void outputs.sync([output()]);
      rejectCreate(0, new Error("fail 1"));
      await vi.advanceTimersByTimeAsync(10);
      expect(h.state.calls).toHaveLength(2);
      const last = new Error("fail 2");
      rejectCreate(1, last);
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toEqual([["p/s", last]]);
    });

    it("cancels pending retries when a later sync no longer wants the key", async () => {
      void outputs.sync([output()]);
      rejectCreate(0, new Error("fail 1"));
      await vi.advanceTimersByTimeAsync(0);
      await outputs.sync([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.state.calls).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it("neither retries nor reports a create that rejects after the key became unwanted", async () => {
      const p = outputs.sync([output()]);
      await outputs.sync([]);
      rejectCreate(0, new Error("late"));
      await p;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.state.calls).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it("disposeAll cancels pending retries", async () => {
      void outputs.sync([output()]);
      rejectCreate(0, new Error("fail 1"));
      await vi.advanceTimersByTimeAsync(0);
      outputs.disposeAll();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.state.calls).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it("a sync during the backoff starts no parallel create, and the retry uses the latest spec", async () => {
      void outputs.sync([output()]);
      rejectCreate(0, new Error("fail 1"));
      await vi.advanceTimersByTimeAsync(0);
      await outputs.sync([output({ width: 1920, height: 1080 })]);
      expect(h.state.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.state.calls).toHaveLength(2);
      expect(h.state.calls[1]).toMatchObject({ width: 1920, height: 1080 });
    });
  });

  describe("runtime failure recovery", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    async function started(): Promise<FakeBridge> {
      void outputs.sync([output()]);
      const bridge = resolveCreate(0);
      await vi.advanceTimersByTimeAsync(0);
      return bridge;
    }

    it("disposes a bridge that emits 'error' and recreates it after 1 s, without reporting", async () => {
      const bridge = await started();
      bridge.emit("error", new Error("send failed"));
      expect(bridge.disposed).toBe(true);
      expect(outputs.keys()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.state.calls).toHaveLength(2);
      resolveCreate(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(outputs.keys()).toEqual(["p/s"]);
      expect(errors).toEqual([]);
    });

    it("recreates a bridge whose offscreen renderer process is gone", async () => {
      const bridge = await started();
      bridge.renderWindow.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      expect(bridge.disposed).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.state.calls).toHaveLength(2);
      resolveCreate(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(outputs.keys()).toEqual(["p/s"]);
      expect(errors).toEqual([]);
    });

    it("recreates only once for a burst of errors from the same bridge", async () => {
      const bridge = await started();
      bridge.emit("error", new Error("a"));
      bridge.emit("error", new Error("b"));
      bridge.renderWindow.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.state.calls).toHaveLength(2);
    });

    it("reports onError when recreation keeps failing after the retry budget", async () => {
      const bridge = await started();
      bridge.emit("error", new Error("send failed"));
      await vi.advanceTimersByTimeAsync(1000);
      rejectCreate(1, new Error("r1"));
      await vi.advanceTimersByTimeAsync(2000);
      rejectCreate(2, new Error("r2"));
      await vi.advanceTimersByTimeAsync(4000);
      expect(errors).toEqual([]);
      const last = new Error("r3");
      rejectCreate(3, last);
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toEqual([["p/s", last]]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.state.calls).toHaveLength(4);
    });

    it("gives up on a bridge that keeps failing right after each recreation", async () => {
      let bridge = await started();
      for (const [i, delay] of [1000, 2000, 4000].entries()) {
        bridge.emit("error", new Error(`e${i}`));
        await vi.advanceTimersByTimeAsync(delay);
        bridge = resolveCreate(i + 1);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(errors).toEqual([]);
      const last = new Error("final");
      bridge.emit("error", last);
      expect(errors).toEqual([["p/s", last]]);
      expect(bridge.disposed).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.state.calls).toHaveLength(4);
    });

    it("restores the full retry budget once a bridge has stayed up for a while", async () => {
      const bridge = await started();
      bridge.emit("error", new Error("e1"));
      await vi.advanceTimersByTimeAsync(1000);
      const second = resolveCreate(1);
      await vi.advanceTimersByTimeAsync(STABLE_AFTER_MS);
      second.emit("error", new Error("e2"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.state.calls).toHaveLength(3);
    });

    it("does not recreate a bridge after it was disabled", async () => {
      const bridge = await started();
      await outputs.sync([]);
      bridge.emit("error", new Error("late"));
      bridge.renderWindow.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 0 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.state.calls).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  });

  it("disposeAll tears down all active bridges", async () => {
    const pA = outputs.sync([output({ key: "a", name: "Hive - A" }), output({ key: "b", name: "Hive - B" })]);
    resolveCreate(0);
    resolveCreate(1);
    await pA;
    outputs.disposeAll();
    expect(outputs.keys()).toEqual([]);
    expect((h.state.bridges[0] as FakeBridge).disposed).toBe(true);
    expect((h.state.bridges[1] as FakeBridge).disposed).toBe(true);
  });

  it("counts frameDropped events per output and logs at most once per 30 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    void outputs.sync([output(), output({ key: "p/t", name: "Hive - Partner - T", path: "/s/p/t" })]);
    const a = resolveCreate(0);
    const b = resolveCreate(1);
    await flush();
    for (let i = 0; i < 5; i++) a.emit("frameDropped", { reason: "no-texture" });
    b.emit("frameDropped", { reason: "no-nt-handle" });
    expect(outputs.droppedFrames("p/s")).toBe(5);
    expect(outputs.droppedFrames("p/t")).toBe(1);
    expect(outputs.droppedFrames("nope")).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[hive] spout output p/s dropped a frame: no-texture");
    vi.advanceTimersByTime(29_999);
    a.emit("frameDropped", { reason: "no-texture" });
    expect(warn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    a.emit("frameDropped", { reason: "no-texture" });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith("[hive] spout output p/s dropped a frame: no-texture (5 more since the last report)");
    expect(outputs.droppedFrames("p/s")).toBe(7);
  });
});
