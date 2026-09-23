import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  windows: [] as unknown[],
  partitions: [] as string[],
  forward: { impl: null as null | ((...args: unknown[]) => Promise<unknown>) },
  load: { impl: (): Promise<void> => Promise.resolve() },
  session: {
    permissionRequest: [] as unknown[],
    permissionCheck: [] as unknown[],
    devicePermission: [] as unknown[],
    displayMedia: [] as unknown[],
    events: null as unknown,
  },
}));

vi.mock("electron", async () => {
  const { EventEmitter: EE } = await import("node:events");
  const ses = new EE() as InstanceType<typeof EE> & Record<string, unknown>;
  h.session.events = ses;
  ses.setPermissionRequestHandler = (fn: unknown) => h.session.permissionRequest.push(fn);
  ses.setPermissionCheckHandler = (fn: unknown) => h.session.permissionCheck.push(fn);
  ses.setDevicePermissionHandler = (fn: unknown) => h.session.devicePermission.push(fn);
  ses.setDisplayMediaRequestHandler = (fn: unknown) => h.session.displayMedia.push(fn);

  class FakeWebContents extends EE {
    windowOpenHandler: (() => unknown) | null = null;
    audioMuted = false;
    frameRate = 0;
    loaded: string[] = [];
    reloads = 0;
    setWindowOpenHandler(fn: () => unknown): void {
      this.windowOpenHandler = fn;
    }
    setAudioMuted(m: boolean): void {
      this.audioMuted = m;
    }
    setFrameRate(f: number): void {
      this.frameRate = f;
    }
    loadURL(url: string): Promise<void> {
      this.loaded.push(url);
      return h.load.impl();
    }
    reload(): void {
      this.reloads += 1;
    }
  }
  class BrowserWindow {
    readonly webContents = new FakeWebContents();
    destroyed = false;
    constructor(readonly options: unknown) {
      h.windows.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return {
    BrowserWindow,
    session: {
      fromPartition: (p: string) => {
        h.partitions.push(p);
        return ses;
      },
    },
  };
});

vi.mock("@napolab/texture-bridge-core/electron", () => ({
  forwardSharedTexture: (...args: unknown[]) => h.forward.impl!(...args),
}));

import { URL_SOURCES_PARTITION, UrlSources } from "../../src/main/url-sources";

interface FakeWebContents extends EventEmitter {
  windowOpenHandler: (() => unknown) | null;
  audioMuted: boolean;
  frameRate: number;
  loaded: string[];
  reloads: number;
}
interface FakeWindow {
  options: { width: number; height: number; show: boolean; webPreferences: Record<string, unknown> };
  webContents: FakeWebContents;
  destroyed: boolean;
}

const win = (i: number): FakeWindow => h.windows[i] as FakeWindow;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function paint(w: FakeWindow): { release: ReturnType<typeof vi.fn>; textureInfo: object } {
  const texture = { textureInfo: { tag: "tex" }, release: vi.fn() };
  w.webContents.emit("paint", { texture }, {}, {});
  return texture;
}

function navEvent(url: string): { url: string; preventDefault: ReturnType<typeof vi.fn> } {
  return { url, preventDefault: vi.fn() };
}

let destroyed: boolean;
const publisher = { isDestroyed: () => destroyed };
let target: typeof publisher | null;
let forwardCalls: unknown[][];
let sources: UrlSources;

beforeEach(() => {
  h.windows = [];
  h.load.impl = () => Promise.resolve();
  destroyed = false;
  target = publisher;
  forwardCalls = [];
  h.forward.impl = async (...args) => {
    forwardCalls.push(args);
    return undefined;
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  sources = new UrlSources(() => target as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UrlSources", () => {
  it("rejects non-http(s) URLs and invalid sizes without creating a window", () => {
    for (const url of ["file:///C:/x.html", "javascript:alert(1)", "data:text/html,hi", "about:blank", "not a url"]) {
      expect(() => sources.open("s1", url, 1920, 1080, 30)).toThrow(/http/);
    }
    expect(() => sources.open("s1", "https://a.test", 0, 1080, 30)).toThrow(/width/);
    expect(() => sources.open("s1", "https://a.test", 1920, 1080, Number.NaN)).toThrow(/fps/);
    expect(() => sources.open("", "https://a.test", 1920, 1080, 30)).toThrow(/sourceId/);
    expect(h.windows).toHaveLength(0);
  });

  it("creates a hidden, sandboxed offscreen window in the isolated session", () => {
    sources.open("s1", "https://overlay.test/a", 1280, 720, 30);
    const w = win(0);
    expect(w.options).toMatchObject({ show: false, width: 1280, height: 720, useContentSize: true });
    expect(w.options.webPreferences).toMatchObject({
      session: h.session.events,
      offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    });
    expect(w.options.webPreferences).not.toHaveProperty("preload");
    expect(h.partitions).toEqual([URL_SOURCES_PARTITION]);
    expect(URL_SOURCES_PARTITION.startsWith("persist:")).toBe(false);
    expect(w.webContents.audioMuted).toBe(true);
    expect(w.webContents.frameRate).toBe(30);
    expect(w.webContents.loaded).toEqual(["https://overlay.test/a"]);
  });

  it("configures the session once, denying permissions, display media and downloads", async () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    sources.open("s2", "https://b.test", 100, 100, 30);
    // Configured once for the whole module, no matter how many sources open.
    expect(h.partitions).toHaveLength(1);
    expect(h.session.permissionRequest).toHaveLength(1);
    expect(h.session.permissionCheck).toHaveLength(1);
    expect(h.session.devicePermission).toHaveLength(1);
    expect(h.session.displayMedia).toHaveLength(1);

    const request = h.session.permissionRequest[0] as (wc: unknown, p: string, cb: (ok: boolean) => void) => void;
    const cb = vi.fn();
    request({}, "media", cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect((h.session.permissionCheck[0] as () => boolean)()).toBe(false);
    expect((h.session.devicePermission[0] as () => boolean)()).toBe(false);
    const display = h.session.displayMedia[0] as (req: unknown, cb: (s: unknown) => void) => void;
    const dcb = vi.fn();
    display({}, dcb);
    expect(dcb).toHaveBeenCalledWith(null);

    const item = { cancel: vi.fn() };
    (h.session.events as EventEmitter).emit("will-download", {}, item, {}, null);
    expect(item.cancel).toHaveBeenCalled();
    expect((h.session.events as EventEmitter).listenerCount("will-download")).toBe(1);
  });

  it("blocks non-http(s) navigation and redirects, allows http(s)", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    for (const event of ["will-navigate", "will-redirect"]) {
      const bad = navEvent("file:///C:/secret.txt");
      wc.emit(event, bad);
      expect(bad.preventDefault).toHaveBeenCalled();
      const ok = navEvent("http://b.test/next");
      wc.emit(event, ok);
      expect(ok.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("denies window.open and webview attachment", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    expect(wc.windowOpenHandler?.()).toEqual({ action: "deny" });
    const e = navEvent("");
    wc.emit("will-attach-webview", e, {}, {});
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("forwards each paint texture tagged with the sourceId and releases it", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    const tex = paint(win(0));
    expect(forwardCalls).toEqual([[tex.textureInfo, publisher, ["s1"]]]);
    expect(tex.release).toHaveBeenCalledTimes(1);
  });

  it("releases the texture even when forwarding throws synchronously", () => {
    h.forward.impl = () => {
      throw new Error("boom");
    };
    sources.open("s1", "https://a.test", 100, 100, 30);
    const texture = { textureInfo: {}, release: vi.fn() };
    expect(() => win(0).webContents.emit("paint", { texture }, {}, {})).toThrow("boom");
    expect(texture.release).toHaveBeenCalledTimes(1);
  });

  it("releases the texture without forwarding when the publisher is missing or destroyed", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    target = null;
    expect(paint(win(0)).release).toHaveBeenCalledTimes(1);
    target = publisher;
    destroyed = true;
    expect(paint(win(0)).release).toHaveBeenCalledTimes(1);
    expect(forwardCalls).toHaveLength(0);
  });

  it("ignores paints without a shared texture", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    win(0).webContents.emit("paint", {}, {}, {});
    expect(forwardCalls).toHaveLength(0);
  });

  it("counts forward defects as dropped frames", async () => {
    h.forward.impl = async () => ({ reason: "target-destroyed" });
    sources.open("s1", "https://a.test", 100, 100, 30);
    paint(win(0));
    paint(win(0));
    await flush();
    expect(sources.droppedFrames("s1")).toBe(2);
  });

  it("a late forward result after close does not resurrect state", async () => {
    let resolve!: (d: unknown) => void;
    h.forward.impl = () => new Promise((r) => (resolve = r));
    sources.open("s1", "https://a.test", 100, 100, 30);
    paint(win(0));
    sources.close("s1");
    h.forward.impl = async () => undefined;
    sources.open("s1", "https://b.test", 100, 100, 30);
    resolve({ reason: "send-failed", cause: new Error("x") });
    await flush();
    expect(sources.droppedFrames("s1")).toBe(0);
  });

  it("close destroys the window; re-open replaces it", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    sources.open("s1", "https://b.test", 100, 100, 30);
    expect(win(0).destroyed).toBe(true);
    expect(win(1).destroyed).toBe(false);
    sources.close("s1");
    expect(win(1).destroyed).toBe(true);
    sources.close("s1");
  });

  it("returns a distinct handle per open; a stale-handle close is ignored", () => {
    const first = sources.open("s1", "https://a.test", 100, 100, 30);
    const second = sources.open("s1", "https://b.test", 100, 100, 30);
    expect(second).not.toBe(first);
    sources.close("s1", first);
    expect(win(1).destroyed).toBe(false);
    sources.close("s1", second);
    expect(win(1).destroyed).toBe(true);
  });

  it("a close without a handle always closes", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    sources.open("s1", "https://b.test", 100, 100, 30);
    sources.close("s1");
    expect(win(1).destroyed).toBe(true);
  });

  it("dispose destroys every window", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    sources.open("s2", "https://b.test", 100, 100, 30);
    sources.dispose();
    expect(win(0).destroyed).toBe(true);
    expect(win(1).destroyed).toBe(true);
  });

  it("logs loadURL rejections instead of throwing", async () => {
    const warn = vi.mocked(console.warn);
    h.load.impl = () => Promise.reject(new Error("ERR_NAME_NOT_RESOLVED"));
    expect(() => sources.open("s1", "https://a.test", 100, 100, 30)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("loadURL failed"), expect.any(Error));
  });

  it("logs main-frame load failures", () => {
    const warn = vi.mocked(console.warn);
    sources.open("s1", "https://a.test", 100, 100, 30);
    win(0).webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://a.test/", true, 0, 0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ERR_NAME_NOT_RESOLVED"));
    warn.mockClear();
    win(0).webContents.emit("did-fail-load", {}, -105, "ERR_X", "https://ads.test/", false, 0, 0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reloads a crashed renderer once after a second, only while still current", () => {
    vi.useFakeTimers();
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(999);
    expect(wc.reloads).toBe(0);
    vi.advanceTimersByTime(1);
    expect(wc.reloads).toBe(1);

    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    sources.close("s1");
    vi.advanceTimersByTime(2000);
    expect(wc.reloads).toBe(1);
  });
});
