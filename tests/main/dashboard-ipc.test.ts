import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DashboardApi } from "../../src/shared/dashboard-api";
import { registerDashboardIpc, type DashboardSession } from "../../src/main/dashboard-ipc";

// The preload (imported below) reads contextBridge/ipcRenderer from here.
const preloadFakes = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: null as null | ((channel: string, ...args: unknown[]) => Promise<unknown>),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => preloadFakes.exposed.set(key, api) },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => preloadFakes.invoke!(channel, ...args),
    on: () => undefined,
  },
}));

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const DASHBOARD = { from: "dashboard" } as unknown as IpcMainInvokeEvent;
const OTHER = { from: "other" } as unknown as IpcMainInvokeEvent;

let handlers: Map<string, Handler>;
let session: { [K in keyof DashboardSession]: Mock };
let listWindows: Mock;
let listSpoutSenders: Mock;
let copy: Mock;

const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): unknown => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(event, ...args);
};

const SOURCE = { kind: "window", name: "Game", preset: "med", windowTitle: "Game" };
const SETTINGS = { displayName: "Ana", turn: null, keepSecret: false };

beforeEach(() => {
  handlers = new Map();
  session = {
    state: vi.fn(() => ({ displayName: "Ana" })),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    kick: vi.fn(),
    addSource: vi.fn(async () => undefined),
    updateSource: vi.fn(async () => undefined),
    removeSource: vi.fn(async () => undefined),
    retrySource: vi.fn(async () => undefined),
    setSpoutOut: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
    dismissBanner: vi.fn(),
  };
  listWindows = vi.fn(async () => [{ title: "Game", thumbnail: "data:," }]);
  listSpoutSenders = vi.fn(() => ["Cam"]);
  copy = vi.fn();
  registerDashboardIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    isFromDashboard: (e) => e === DASHBOARD,
    session: session as unknown as DashboardSession,
    listWindows,
    listSpoutSenders,
    copy,
  });
});

const CHANNELS: [string, unknown[]][] = [
  ["hive:dash:get-state", []],
  ["hive:dash:start-server", []],
  ["hive:dash:stop-server", []],
  ["hive:dash:join", ["https://a.trycloudflare.com/join#s"]],
  ["hive:dash:leave", []],
  ["hive:dash:kick", []],
  ["hive:dash:add-source", [SOURCE]],
  ["hive:dash:update-source", ["id1", SOURCE]],
  ["hive:dash:remove-source", ["id1"]],
  ["hive:dash:retry-source", ["id1"]],
  ["hive:dash:set-spout-out", ["bo", "game", true]],
  ["hive:dash:update-settings", [SETTINGS]],
  ["hive:dash:dismiss-banner", ["p2p-failed"]],
  ["hive:dash:list-windows", []],
  ["hive:dash:list-spout-senders", []],
  ["hive:dash:copy", ["hello"]],
];

const nothingCalled = (): void => {
  for (const fn of [...Object.values(session), listWindows, listSpoutSenders, copy]) expect(fn).not.toHaveBeenCalled();
};

describe("registerDashboardIpc", () => {
  it("registers every channel", () => {
    expect([...handlers.keys()].sort()).toEqual(CHANNELS.map(([c]) => c).sort());
  });

  it.each(CHANNELS)("%s rejects callers other than the dashboard without acting", (channel, args) => {
    expect(() => call(channel, OTHER, ...args)).toThrow("forbidden");
    nothingCalled();
  });

  it("passes valid calls through to the session and helpers", async () => {
    expect(call("hive:dash:get-state", DASHBOARD)).toEqual({ displayName: "Ana" });
    call("hive:dash:join", DASHBOARD, "https://x/join#s");
    expect(session.join).toHaveBeenCalledWith("https://x/join#s");
    await call("hive:dash:update-source", DASHBOARD, "id1", SOURCE);
    expect(session.updateSource).toHaveBeenCalledWith("id1", SOURCE);
    await call("hive:dash:set-spout-out", DASHBOARD, "bo", "game", false);
    expect(session.setSpoutOut).toHaveBeenCalledWith("bo", "game", false);
    await call("hive:dash:update-settings", DASHBOARD, {
      ...SETTINGS,
      turn: { url: "turn:t.test", username: "u", credential: "c" },
    });
    expect(session.updateSettings).toHaveBeenCalled();
    call("hive:dash:dismiss-banner", DASHBOARD, "publisher-down");
    expect(session.dismissBanner).toHaveBeenCalledWith("publisher-down");
    await expect(call("hive:dash:list-windows", DASHBOARD)).resolves.toEqual([{ title: "Game", thumbnail: "data:," }]);
    expect(call("hive:dash:list-spout-senders", DASHBOARD)).toEqual(["Cam"]);
    call("hive:dash:copy", DASHBOARD, "");
    expect(copy).toHaveBeenCalledWith("");
  });

  it("propagates session rejections to the invoke", async () => {
    session.retrySource.mockRejectedValue(new Error("Source not found."));
    await expect(call("hive:dash:retry-source", DASHBOARD, "nope")).rejects.toThrow("Source not found.");
  });

  it.each([
    ["hive:dash:join", [42]],
    ["hive:dash:join", [""]],
    ["hive:dash:join", ["x".repeat(4097)]],
    ["hive:dash:add-source", [null]],
    ["hive:dash:add-source", ["window"]],
    ["hive:dash:add-source", [[SOURCE]]],
    ["hive:dash:add-source", [{ ...SOURCE, name: 5 }]],
    ["hive:dash:add-source", [{ name: "x" }]],
    ["hive:dash:update-source", [1, SOURCE]],
    ["hive:dash:update-source", ["id1", undefined]],
    ["hive:dash:remove-source", [{}]],
    ["hive:dash:remove-source", ["x".repeat(257)]],
    ["hive:dash:retry-source", [undefined]],
    ["hive:dash:set-spout-out", ["bo", "game", "true"]],
    ["hive:dash:set-spout-out", ["bo", "game", 1]],
    ["hive:dash:set-spout-out", ["", "game", true]],
    ["hive:dash:set-spout-out", ["bo", null, true]],
    ["hive:dash:update-settings", [null]],
    ["hive:dash:update-settings", [{ ...SETTINGS, displayName: 1 }]],
    ["hive:dash:update-settings", [{ ...SETTINGS, keepSecret: "yes" }]],
    ["hive:dash:update-settings", [{ ...SETTINGS, turn: "turn:x" }]],
    ["hive:dash:update-settings", [{ ...SETTINGS, turn: { url: "turn:x", username: "u" } }]],
    ["hive:dash:update-settings", [{ displayName: "Ana", keepSecret: false }]],
    ["hive:dash:dismiss-banner", ["not-a-banner"]],
    ["hive:dash:dismiss-banner", [3]],
    ["hive:dash:copy", [7]],
    ["hive:dash:copy", ["x".repeat(16_385)]],
  ] as [string, unknown[]][])("%s rejects invalid arguments %j", (channel, args) => {
    expect(() => call(channel, DASHBOARD, ...args)).toThrow(/invalid/);
    nothingCalled();
  });
});

describe("dashboard preload", () => {
  it("exposes window.hive whose every method invokes a registered channel", async () => {
    await import("../../src/preload/dashboard");
    const api = preloadFakes.exposed.get("hive") as DashboardApi;
    expect(api).toBeDefined();
    const invoked: string[] = [];
    preloadFakes.invoke = async (channel, ...args) => {
      invoked.push(channel);
      return call(channel, DASHBOARD, ...args);
    };
    await api.getState();
    await api.startServer();
    await api.stopServer();
    await api.join("https://x/join#s");
    await api.leave();
    await api.kick();
    await api.addSource(SOURCE as never);
    await api.updateSource("id1", SOURCE as never);
    await api.removeSource("id1");
    await api.retrySource("id1");
    await api.setSpoutOut("bo", "game", true);
    await api.updateSettings(SETTINGS);
    await api.dismissBanner("p2p-failed");
    await api.listWindows();
    await api.listSpoutSenders();
    await api.copy("x");
    expect(invoked.sort()).toEqual([...handlers.keys()].sort());
  });
});
