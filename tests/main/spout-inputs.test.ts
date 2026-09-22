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
      this.disposed = true;
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
    inputs.open("s1", "Cam");
    receiver(0).emit("error", new ReceiverStoppedError(10));
    expect(receiver(1).disposed).toBe(false);
    expect(events).toEqual([]);
  });

  it("dispose stops discovery and disposes every receiver", () => {
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
