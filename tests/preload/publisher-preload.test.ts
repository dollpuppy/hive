import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  onFrame: null as null | ((frame: { videoFrame: unknown }, ...args: unknown[]) => void),
}));

vi.mock("electron", () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock("@napolab/texture-bridge-renderer/client", () => ({
  installSharedTextureReceiver: vi.fn(),
  consumeSharedTexture: (opts: { onFrame: typeof h.onFrame }) => {
    h.onFrame = opts.onFrame;
  },
}));

let win: { hiveFrames: { register(id: string, sink: (f: unknown) => void): () => void } };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  win = {} as typeof win;
  vi.stubGlobal("window", win);
  vi.resetModules();
  await import("../../src/preload/publisher");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("publisher preload frame sinks", () => {
  it("rate-limits a throwing sink's errors to one per 5 s per source, counting the rest", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    win.hiveFrames.register("a", () => {
      throw new Error("boom");
    });
    win.hiveFrames.register("b", () => {
      throw new Error("bang");
    });
    const frame = { videoFrame: {} };
    for (let i = 0; i < 10; i++) h.onFrame?.(frame, "a");
    h.onFrame?.(frame, "b");
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[0]).toBe("[hive] frame sink threw");
    vi.advanceTimersByTime(4999);
    h.onFrame?.(frame, "a");
    expect(error).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    h.onFrame?.(frame, "a");
    expect(error).toHaveBeenCalledTimes(3);
    expect(error.mock.calls[2]?.[0]).toBe("[hive] frame sink threw (10 similar errors suppressed)");
    expect(error.mock.calls[2]?.[1]).toBe("a");
  });
});
