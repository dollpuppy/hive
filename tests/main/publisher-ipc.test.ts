import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { SourceConfig } from "../../src/main/config/config-store";
import { EventEmitter } from "node:events";
import { forwardPublisherEvents, registerPublisherIpc } from "../../src/main/publisher-ipc";

vi.mock("electron", () => ({}));

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const PUBLISHER = { from: "publisher" } as unknown as IpcMainInvokeEvent;
const OTHER = { from: "other" } as unknown as IpcMainInvokeEvent;

let handlers: Map<string, Handler>;
let sources: SourceConfig[];
let spout: {
  senders: Mock<() => string[]>;
  open: Mock<(sourceId: string, senderName: string) => number>;
  close: Mock<(sourceId: string, handle?: number) => void>;
};
let url: {
  open: Mock<(sourceId: string, url: string, width: number, height: number, fps: number) => number>;
  close: Mock<(sourceId: string, handle?: number) => void>;
};

const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): unknown => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(event, ...args);
};

beforeEach(() => {
  handlers = new Map();
  sources = [
    { id: "v1", name: "VT", slug: "vt", preset: "low", kind: "spout", senderName: "Cam" },
    { id: "u1", name: "Page", slug: "page", preset: "high", kind: "url", url: "https://a.test/", width: 1280, height: 720 },
    { id: "w1", name: "Win", slug: "win", preset: "med", kind: "window", windowTitle: "X" },
  ];
  spout = { senders: vi.fn(() => ["Cam"]), open: vi.fn(() => 7), close: vi.fn() };
  url = { open: vi.fn(() => 9), close: vi.fn() };
  registerPublisherIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    isFromPublisher: (e) => e === PUBLISHER,
    sources: () => sources,
    spout,
    url,
  });
});

const CHANNELS: [string, unknown[]][] = [
  ["hive:publisher:spout-senders", []],
  ["hive:publisher:spout-open", ["v1", "Cam"]],
  ["hive:publisher:spout-close", ["v1", 1]],
  ["hive:publisher:url-open", ["u1"]],
  ["hive:publisher:url-close", ["u1", 1]],
];

describe("registerPublisherIpc", () => {
  it("registers every channel", () => {
    expect([...handlers.keys()].sort()).toEqual(CHANNELS.map(([c]) => c).sort());
  });

  it.each(CHANNELS)("%s rejects callers other than the Publisher without acting", (channel, args) => {
    expect(() => call(channel, OTHER, ...args)).toThrow("forbidden");
    expect(spout.senders).not.toHaveBeenCalled();
    expect(spout.open).not.toHaveBeenCalled();
    expect(spout.close).not.toHaveBeenCalled();
    expect(url.open).not.toHaveBeenCalled();
    expect(url.close).not.toHaveBeenCalled();
  });

  it("lists spout senders", () => {
    expect(call("hive:publisher:spout-senders", PUBLISHER)).toEqual(["Cam"]);
  });

  it("opens a configured spout source synchronously and returns its handle", () => {
    expect(call("hive:publisher:spout-open", PUBLISHER, "v1", "Cam")).toBe(7);
    expect(spout.open).toHaveBeenCalledWith("v1", "Cam");
  });

  it("refuses spout senders that are not the source's configured sender", () => {
    expect(() => call("hive:publisher:spout-open", PUBLISHER, "v1", "Other")).toThrow(/unknown spout source/);
    expect(() => call("hive:publisher:spout-open", PUBLISHER, "u1", "Cam")).toThrow(/unknown spout source/);
    expect(() => call("hive:publisher:spout-open", PUBLISHER, "nope", "Cam")).toThrow(/unknown spout source/);
    expect(spout.open).not.toHaveBeenCalled();
  });

  it("reads the current sources on each call", () => {
    sources = [{ id: "v1", name: "VT", slug: "vt", preset: "low", kind: "spout", senderName: "Renamed" }];
    expect(() => call("hive:publisher:spout-open", PUBLISHER, "v1", "Cam")).toThrow();
    expect(call("hive:publisher:spout-open", PUBLISHER, "v1", "Renamed")).toBe(7);
  });

  it("propagates open failures (e.g. missing sender) to the invoke", () => {
    spout.open.mockImplementation(() => {
      throw new Error("no such sender");
    });
    expect(() => call("hive:publisher:spout-open", PUBLISHER, "v1", "Cam")).toThrow("no such sender");
  });

  it("opens a url source from config with the preset's fps, never a renderer-supplied URL", () => {
    expect(call("hive:publisher:url-open", PUBLISHER, "u1", "https://evil.test/")).toBe(9);
    expect(url.open).toHaveBeenCalledWith("u1", "https://a.test/", 1280, 720, 60);
  });

  it("refuses url-open for unknown or non-url sources", () => {
    expect(() => call("hive:publisher:url-open", PUBLISHER, "v1")).toThrow(/unknown url source/);
    expect(() => call("hive:publisher:url-open", PUBLISHER, "zz")).toThrow(/unknown url source/);
    expect(url.open).not.toHaveBeenCalled();
  });

  it("closes with the handle", () => {
    call("hive:publisher:spout-close", PUBLISHER, "v1", 3);
    call("hive:publisher:url-close", PUBLISHER, "u1", 4);
    expect(spout.close).toHaveBeenCalledWith("v1", 3);
    expect(url.close).toHaveBeenCalledWith("u1", 4);
  });

  it.each([
    ["hive:publisher:spout-open", [1, "Cam"]],
    ["hive:publisher:spout-open", ["", "Cam"]],
    ["hive:publisher:spout-open", ["v1", ""]],
    ["hive:publisher:spout-open", ["v1", { toString: () => "Cam" }]],
    ["hive:publisher:spout-open", ["x".repeat(257), "Cam"]],
    ["hive:publisher:url-open", [null]],
    ["hive:publisher:spout-close", ["v1", undefined]],
    ["hive:publisher:spout-close", ["v1", 1.5]],
    ["hive:publisher:spout-close", ["v1", "1"]],
    ["hive:publisher:spout-close", ["v1", 0]],
    ["hive:publisher:spout-close", [null, 1]],
    ["hive:publisher:url-close", ["u1", Number.MAX_SAFE_INTEGER + 1]],
    ["hive:publisher:url-close", ["u1", Number.NaN]],
    ["hive:publisher:url-close", [{}, 1]],
  ] as [string, unknown[]][])("%s rejects invalid arguments %j", (channel, args) => {
    expect(() => call(channel, PUBLISHER, ...args)).toThrow(/invalid/);
    expect(spout.open).not.toHaveBeenCalled();
    expect(spout.close).not.toHaveBeenCalled();
    expect(url.open).not.toHaveBeenCalled();
    expect(url.close).not.toHaveBeenCalled();
  });
});

describe("forwardPublisherEvents", () => {
  it("forwards spout availability and url give-ups to the Publisher, skipping a missing or destroyed one", () => {
    const spoutEvents = new EventEmitter();
    const urlEvents = new EventEmitter();
    const sent: unknown[][] = [];
    let destroyed = false;
    let present = true;
    const wc = { isDestroyed: () => destroyed, send: (...args: unknown[]) => sent.push(args) };
    forwardPublisherEvents({ target: () => (present ? wc : null), spout: spoutEvents, url: urlEvents });

    spoutEvents.emit("availability", "Cam", false);
    urlEvents.emit("failed", "u1", 4, "4 failures within 60 s");
    expect(sent).toEqual([
      ["hive:publisher:spout-availability", "Cam", false],
      ["hive:publisher:url-failed", "u1", 4],
    ]);

    destroyed = true;
    urlEvents.emit("failed", "u1", 5, "x");
    destroyed = false;
    present = false;
    spoutEvents.emit("availability", "Cam", true);
    expect(sent).toHaveLength(2);
  });
});
