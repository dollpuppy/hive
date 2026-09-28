import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    listed: [] as { name: string }[],
    discoveries: [] as unknown[],
    receivers: [] as unknown[],
    createThrows: null as Error | null,
  };
  return { state };
});

vi.mock("electron", () => ({}));

vi.mock("@napolab/texture-bridge-core", () => ({
  listSenders: () => h.state.listed,
}));

vi.mock("@napolab/texture-bridge-renderer", async () => {
  const { EventEmitter: EE } = await import("node:events");
  class ReceiverStoppedError extends Error {}
  class SenderDiscovery extends EE {
    snapshot: { name: string }[] = [];
    started: number | null = null;
    disposed = false;
    constructor() {
      super();
      h.state.discoveries.push(this);
    }
    start(ms: number): void {
      this.started = ms;
    }
    getSenders(): { name: string }[] {
      return [...this.snapshot];
    }
    dispose(): void {
      this.disposed = true;
      this.removeAllListeners();
    }
  }
  class FakeReceiver extends EE {
    started = false;
    disposed = false;
    constructor(readonly opts: unknown) {
      super();
    }
    start(): void {
      this.started = true;
    }
    dispose(): void {
      // Like the real receiver, disposal detaches every listener.
      this.disposed = true;
      this.removeAllListeners();
    }
  }
  return {
    ReceiverStoppedError,
    SenderDiscovery,
    createSharedTextureReceiver: (opts: unknown) => {
      if (h.state.createThrows) throw h.state.createThrows;
      const r = new FakeReceiver(opts);
      h.state.receivers.push(r);
      return r;
    },
  };
});

import { ReceiverStoppedError } from "@napolab/texture-bridge-renderer";
import { SpoutInputs } from "../../src/main/spout/spout-inputs";

interface FakeDiscovery extends EventEmitter {
  snapshot: { name: string }[];
  started: number | null;
  disposed: boolean;
}
interface FakeReceiver extends EventEmitter {
  opts: { senderName: string; target: unknown; extraArgs: unknown[] };
  started: boolean;
  disposed: boolean;
}

const discovery = (): FakeDiscovery => h.state.discoveries.at(-1) as FakeDiscovery;
const receiver = (i: number): FakeReceiver => h.state.receivers[i] as FakeReceiver;

let destroyed: boolean;
const publisher = { isDestroyed: () => destroyed };
let target: typeof publisher | null;
let inputs: SpoutInputs;
let events: [string, boolean][];

beforeEach(() => {
  h.state.listed = [];
  h.state.discoveries = [];
  h.state.receivers = [];
  h.state.createThrows = null;
  destroyed = false;
  target = publisher;
  events = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  inputs = new SpoutInputs(() => target as never);
  inputs.on("availability", (name: string, available: boolean) => events.push([name, available]));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SpoutInputs", () => {
  it("lists existing senders sorted, hiding Hive's own outputs", () => {
    h.state.listed = [{ name: "Zeta" }, { name: "Hive - Program" }, { name: "Alpha" }];
    inputs.start();
    expect(inputs.senders()).toEqual(["Alpha", "Zeta"]);
    expect(discovery().started).toBe(1000);
  });

  it("start is idempotent", () => {
    inputs.start();
    inputs.start();
    expect(discovery().listenerCount("added")).toBe(1);
  });

  it("added and removed events update senders and emit availability", () => {
    inputs.start();
    discovery().emit("added", [{ name: "Cam" }]);
    expect(inputs.senders()).toEqual(["Cam"]);
    discovery().emit("removed", [{ name: "Cam" }]);
    expect(inputs.senders()).toEqual([]);
    expect(events).toEqual([
      ["Cam", true],
      ["Cam", false],
    ]);
  });

  it("removed disposes only that sender's receivers", () => {
    inputs.start();
    discovery().emit("added", [{ name: "Cam" }, { name: "Other" }]);
    inputs.open("s1", "Cam");
    inputs.open("s2", "Cam");
    inputs.open("s3", "Other");
    discovery().snapshot = [{ name: "Other" }];
    discovery().emit("removed", [{ name: "Cam" }]);
    expect(receiver(0).disposed).toBe(true);
    expect(receiver(1).disposed).toBe(true);
    expect(receiver(2).disposed).toBe(false);
  });

  it("ignores a removal while another sender still publishes the same name", () => {
    inputs.start();
    discovery().emit("added", [{ name: "Cam" }]);
    inputs.open("s1", "Cam");
    discovery().snapshot = [{ name: "Cam" }];
    discovery().emit("removed", [{ name: "Cam" }]);
    expect(receiver(0).disposed).toBe(false);
    expect(inputs.senders()).toEqual(["Cam"]);
  });

  it("closeAll disposes every receiver but keeps discovery and allows re-opening", () => {
    inputs.start();
    discovery().emit("added", [{ name: "Cam" }, { name: "Other" }]);
    inputs.open("s1", "Cam");
    inputs.open("s2", "Other");
    inputs.closeAll();
    expect(receiver(0).disposed).toBe(true);
    expect(receiver(1).disposed).toBe(true);
    expect(discovery().disposed).toBe(false);
    expect(inputs.senders()).toEqual(["Cam", "Other"]);
    discovery().emit("added", [{ name: "New" }]);
    expect(events).toContainEqual(["New", true]);
    inputs.open("s1", "Cam");
    expect(receiver(2).started).toBe(true);
  });

  it("closeAll keeps a pending nudge for a stopped receiver", () => {
    vi.useFakeTimers();
    inputs.start();
    discovery().emit("added", [{ name: "Cam" }]);
    inputs.open("s1", "Cam");
    receiver(0).emit("error", new ReceiverStoppedError(10));
    inputs.closeAll();
    events = [];
    vi.advanceTimersByTime(3000);
    expect(events).toEqual([["Cam", true]]);
  });

  it("opens a started receiver targeting the publisher, tagged with the sourceId", () => {
    inputs.open("s1", "Cam");
    const r = receiver(0);
    expect(r.opts).toEqual({ senderName: "Cam", target: publisher, extraArgs: ["s1"] });
    expect(r.started).toBe(true);
  });

  it("re-opening a sourceId disposes the previous receiver", () => {
    inputs.open("s1", "Cam");
    inputs.open("s1", "Other");
    expect(receiver(0).disposed).toBe(true);
    expect(receiver(1).disposed).toBe(false);
  });

  it("throws when the publisher is missing or destroyed", () => {
    target = null;
    expect(() => inputs.open("s1", "Cam")).toThrow("publisher not ready");
    target = publisher;
    destroyed = true;
    expect(() => inputs.open("s1", "Cam")).toThrow("publisher not ready");
    expect(h.state.receivers).toHaveLength(0);
  });

  it("propagates a receiver construction failure and keeps no entry", () => {
    h.state.createThrows = new Error("no such sender");
    expect(() => inputs.open("s1", "Gone")).toThrow("no such sender");
    h.state.createThrows = null;
    // No entry was left behind: a stop from nowhere has nothing to close.
    inputs.open("s2", "Cam");
    inputs.close("s1");
    expect(receiver(0).disposed).toBe(false);
  });

  it("tags a receiver construction failure as a missing sender", () => {
    h.state.createThrows = new Error("no such sender");
    expect(() => inputs.open("s1", "Gone")).toThrow(/^spout-sender-missing: "Gone" could not be received: no such sender$/);
  });

  it("once started, refuses senders Spout doesn't list, tagged as missing", () => {
    h.state.listed = [{ name: "Cam" }];
    inputs.start();
    expect(() => inputs.open("s1", "Gone")).toThrow(/^spout-sender-missing: "Gone" is not listed$/);
    expect(h.state.receivers).toHaveLength(0);
    inputs.open("s1", "Cam");
    discovery().emit("added", [{ name: "Late" }]);
    inputs.open("s2", "Late");
    expect(h.state.receivers).toHaveLength(2);
  });

  it("does not tag other open failures as missing", () => {
    target = null;
    expect(() => inputs.open("s1", "Cam")).toThrow(/^publisher not ready$/);
    target = publisher;
    expect(() => inputs.open("s1", "Hive - X")).not.toThrow(/spout-sender-missing/);
  });

  it("a failed re-open leaves the source's previous receiver running", () => {
    inputs.open("s1", "Cam");
    h.state.createThrows = new Error("no such sender");
    expect(() => inputs.open("s1", "Gone")).toThrow("no such sender");
    expect(receiver(0).disposed).toBe(false);
    inputs.close("s1");
    expect(receiver(0).disposed).toBe(true);
  });

  it("refuses Hive's own outputs and invalid input", () => {
    expect(() => inputs.open("s1", "Hive - Program")).toThrow(/own output/);
    expect(() => inputs.open("", "Cam")).toThrow(/sourceId/);
    expect(() => inputs.open("s1", "")).toThrow(/sender name/);
    expect(() => inputs.open(42 as never, "Cam")).toThrow(/sourceId/);
    expect(h.state.receivers).toHaveLength(0);
  });

  it("ReceiverStoppedError closes the receiver and reports it unavailable", () => {
    inputs.start();
    discovery().emit("added", [{ name: "Cam" }]);
    events = [];
    inputs.open("s1", "Cam");
    receiver(0).emit("error", new ReceiverStoppedError(10));
    expect(receiver(0).disposed).toBe(true);
    expect(events).toEqual([["Cam", false]]);
    // Still listed by Spout, so still pickable.
    expect(inputs.senders()).toEqual(["Cam"]);
  });

  it("other receiver errors are logged without closing", () => {
    inputs.open("s1", "Cam");
    receiver(0).emit("error", new Error("import failed"));
    expect(receiver(0).disposed).toBe(false);
    expect(events).toEqual([]);
  });

  it("a stale receiver's stop does not close the newer receiver for the same sourceId", () => {
    inputs.open("s1", "Cam");
    // Grab the handler before re-opening detaches it, as if the stop was already queued.
    const staleHandler = receiver(0).listeners("error")[0] as (err: Error) => void;
    inputs.open("s1", "Cam");
    expect(receiver(0).listenerCount("error")).toBe(0);
    staleHandler(new ReceiverStoppedError(10));
    expect(receiver(1).disposed).toBe(false);
    expect(events).toEqual([]);
  });

  it("rate-limits non-stop receiver error logs per receiver", () => {
    vi.useFakeTimers();
    const warn = vi.mocked(console.warn);
    inputs.open("s1", "Cam");
    inputs.open("s2", "Other");
    for (let i = 0; i < 5; i++) receiver(0).emit("error", new Error("import failed"));
    receiver(1).emit("error", new Error("import failed"));
    expect(warn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    receiver(0).emit("error", new Error("import failed"));
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("4 similar errors suppressed"), expect.any(Error));
  });

  it("returns a distinct handle per open", () => {
    const a = inputs.open("s1", "Cam");
    const b = inputs.open("s1", "Cam");
    const c = inputs.open("s2", "Cam");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("a close with a stale handle leaves the newer open running", () => {
    const first = inputs.open("s1", "Cam");
    const second = inputs.open("s1", "Cam");
    inputs.close("s1", first);
    expect(receiver(1).disposed).toBe(false);
    inputs.close("s1", second);
    expect(receiver(1).disposed).toBe(true);
  });

  it("a close without a handle always closes", () => {
    inputs.open("s1", "Cam");
    inputs.open("s1", "Cam");
    inputs.close("s1");
    expect(receiver(1).disposed).toBe(true);
  });

  it("dispose stops discovery and disposes every receiver", () => {
    h.state.listed = [{ name: "Cam" }, { name: "Other" }];
    inputs.start();
    inputs.open("s1", "Cam");
    inputs.open("s2", "Other");
    inputs.dispose();
    expect(discovery().disposed).toBe(true);
    expect(receiver(0).disposed).toBe(true);
    expect(receiver(1).disposed).toBe(true);
    expect(inputs.listenerCount("availability")).toBe(0);
    expect(() => inputs.open("s3", "Cam")).toThrow(/disposed/);
  });
});

describe("SpoutInputs retry nudges", () => {
  function startWith(name: string): void {
    vi.useFakeTimers();
    inputs.start();
    discovery().emit("added", [{ name }]);
    discovery().snapshot = [{ name }];
    events = [];
  }
  const stop = (i: number): void => {
    receiver(i).emit("error", new ReceiverStoppedError(10));
  };

  it("re-reports a stopped but still-listed sender available after 3 s", () => {
    startWith("Cam");
    inputs.open("s1", "Cam");
    stop(0);
    expect(events).toEqual([["Cam", false]]);
    vi.advanceTimersByTime(2999);
    expect(events).toEqual([["Cam", false]]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([
      ["Cam", false],
      ["Cam", true],
    ]);
  });

  it("doubles the delay per consecutive failure, capped at 60 s", () => {
    startWith("Cam");
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      inputs.open("s1", "Cam");
      stop(i);
      events = [];
      let waited = 0;
      while (events.length === 0) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000]);
  });

  it("nudges when receiver construction fails for a listed sender", () => {
    startWith("Cam");
    h.state.createThrows = new Error("open failed");
    expect(() => inputs.open("s1", "Cam")).toThrow("open failed");
    vi.advanceTimersByTime(3000);
    expect(events).toEqual([["Cam", true]]);
  });

  it("does not nudge a failed open for an unknown sender", () => {
    vi.useFakeTimers();
    h.state.createThrows = new Error("no such sender");
    expect(() => inputs.open("s1", "Gone")).toThrow();
    vi.advanceTimersByTime(120_000);
    expect(events).toEqual([]);
  });

  it("keeps at most one pending nudge per sender", () => {
    startWith("Cam");
    inputs.open("s1", "Cam");
    inputs.open("s2", "Cam");
    stop(0);
    stop(1);
    vi.advanceTimersByTime(60_000);
    expect(events.filter(([, a]) => a)).toHaveLength(1);
  });

  it("drops the nudge when the sender disappears before it fires", () => {
    startWith("Cam");
    inputs.open("s1", "Cam");
    stop(0);
    discovery().snapshot = [];
    discovery().emit("removed", [{ name: "Cam" }]);
    vi.advanceTimersByTime(60_000);
    expect(events).toEqual([
      ["Cam", false],
      ["Cam", false],
    ]);
  });

  it("resets the backoff after an open survives 30 s", () => {
    startWith("Cam");
    inputs.open("s1", "Cam");
    stop(0);
    vi.advanceTimersByTime(3000); // nudge 1 (next would be 6 s)
    inputs.open("s1", "Cam");
    vi.advanceTimersByTime(30_000); // healthy: backoff reset
    stop(1);
    events = [];
    vi.advanceTimersByTime(3000);
    expect(events).toEqual([["Cam", true]]);
  });

  it("a stop within 30 s of opening keeps the backoff growing", () => {
    startWith("Cam");
    inputs.open("s1", "Cam");
    stop(0);
    vi.advanceTimersByTime(3000);
    inputs.open("s1", "Cam");
    vi.advanceTimersByTime(10_000);
    stop(1);
    events = [];
    vi.advanceTimersByTime(5999);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([["Cam", true]]);
  });

  it("a discovery re-add resets the backoff", () => {
    startWith("Cam");
    inputs.open("s1", "Cam");
    stop(0);
    vi.advanceTimersByTime(3000);
    discovery().emit("added", [{ name: "Cam" }]);
    inputs.open("s1", "Cam");
    stop(1);
    events = [];
    vi.advanceTimersByTime(3000);
    expect(events).toEqual([["Cam", true]]);
  });

  it("dispose clears pending nudges", () => {
    startWith("Cam");
    inputs.open("s1", "Cam");
    stop(0);
    const emit = vi.spyOn(inputs, "emit");
    inputs.dispose();
    vi.advanceTimersByTime(120_000);
    expect(emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
