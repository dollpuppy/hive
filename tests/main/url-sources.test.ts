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
    onBeforeRequest: [] as unknown[],
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
  ses.webRequest = {
    onBeforeRequest: (fn: unknown) => h.session.onBeforeRequest.push(fn),
  };

  class FakeWebContents extends EE {
    windowOpenHandler: (() => unknown) | null = null;
    audioMuted = false;
    frameRate = 0;
    loaded: string[] = [];
    reloads = 0;
    invalidations = 0;
    invalidate(): void {
      this.invalidations += 1;
    }
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
  invalidations: number;
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
  sources.dispose();
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
      disableDialogs: true,
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

  it("closeAll destroys every window and leaves the instance reusable", () => {
    sources.open("s1", "https://a.test", 100, 100, 30);
    sources.open("s2", "https://b.test", 100, 100, 30);
    sources.closeAll();
    expect(win(0).destroyed).toBe(true);
    expect(win(1).destroyed).toBe(true);
    const handle = sources.open("s1", "https://a.test", 100, 100, 30);
    expect(win(2).destroyed).toBe(false);
    sources.close("s1", handle);
    expect(win(2).destroyed).toBe(true);
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

  it("backs off crash reloads and gives up after more than 3 crashes in 60 s", () => {
    vi.useFakeTimers();
    const error = vi.mocked(console.error);
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    const crash = (): void => {
      wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    };
    crash();
    vi.advanceTimersByTime(1000);
    expect(wc.reloads).toBe(1);
    crash();
    vi.advanceTimersByTime(1999);
    expect(wc.reloads).toBe(1);
    vi.advanceTimersByTime(1);
    expect(wc.reloads).toBe(2);
    crash();
    vi.advanceTimersByTime(4000);
    expect(wc.reloads).toBe(3);
    crash();
    vi.advanceTimersByTime(60_000);
    expect(wc.reloads).toBe(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("giving up"));
  });

  it("forgets crashes older than 60 s", () => {
    vi.useFakeTimers();
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    for (let i = 0; i < 3; i++) {
      wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      vi.advanceTimersByTime(4000);
    }
    expect(wc.reloads).toBe(3);
    vi.advanceTimersByTime(61_000);
    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(1000);
    expect(wc.reloads).toBe(4);
  });

  it("retries a failed main-frame load with the same backoff", () => {
    vi.useFakeTimers();
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    const fail = (code: number, main = true): void => {
      wc.emit("did-fail-load", {}, code, "ERR", "https://a.test/", main, 0, 0);
    };
    fail(-105);
    vi.advanceTimersByTime(1000);
    expect(wc.loaded).toEqual(["https://a.test", "https://a.test"]);
    fail(-105);
    vi.advanceTimersByTime(2000);
    expect(wc.loaded).toHaveLength(3);
    // Aborted navigations and subframe failures are not retried.
    fail(-3);
    fail(-105, false);
    vi.advanceTimersByTime(60_000);
    expect(wc.loaded).toHaveLength(3);
  });

  it("close cancels a pending load retry", () => {
    vi.useFakeTimers();
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    wc.emit("did-fail-load", {}, -105, "ERR", "https://a.test/", true, 0, 0);
    sources.dispose();
    vi.advanceTimersByTime(60_000);
    expect(wc.loaded).toHaveLength(1);
  });

  it("invalidates once after load, but not on a repeating timer", () => {
    vi.useFakeTimers();
    sources.open("s1", "https://a.test", 100, 100, 30);
    const wc = win(0).webContents;
    wc.emit("did-finish-load");
    expect(wc.invalidations).toBe(1);
    // A repeating invalidate() was tried and found not to produce new paints for an
    // unchanged page (see the comment in url-sources.ts), so it was removed: keepalive
    // now happens downstream in the Publisher instead.
    vi.advanceTimersByTime(5000);
    expect(wc.invalidations).toBe(1);
    sources.close("s1");
    expect(vi.getTimerCount()).toBe(0);
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

  describe("giving up", () => {
    const failLoad = (wc: FakeWebContents): void => {
      wc.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://127.0.0.1:9/", true, 0, 0);
    };

    it("emits failed once with the open's handle and destroys the window", () => {
      vi.useFakeTimers();
      const failed: unknown[][] = [];
      sources.on("failed", (...args: unknown[]) => failed.push(args));
      const handle = sources.open("s1", "http://127.0.0.1:9/", 100, 100, 30);
      const wc = win(0).webContents;
      for (let i = 0; i < 3; i++) {
        failLoad(wc);
        vi.advanceTimersByTime(4000);
      }
      expect(failed).toEqual([]);
      failLoad(wc);
      expect(failed).toEqual([["s1", handle, expect.stringContaining("ERR_CONNECTION_REFUSED")]]);
      // Destroyed on the next tick, not inside the webContents event.
      expect(win(0).destroyed).toBe(false);
      vi.advanceTimersByTime(0);
      expect(win(0).destroyed).toBe(true);
      // Late events from the dead window do nothing more.
      failLoad(wc);
      wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      vi.advanceTimersByTime(60_000);
      expect(failed).toHaveLength(1);
      expect(wc.loaded).toHaveLength(4);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("forgets the open, so its close is a no-op and a re-open starts fresh", () => {
      vi.useFakeTimers();
      const failed: unknown[][] = [];
      sources.on("failed", (...args: unknown[]) => failed.push(args));
      const handle = sources.open("s1", "https://a.test", 100, 100, 30);
      const wc = win(0).webContents;
      for (let i = 0; i < 4; i++) {
        wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
        vi.advanceTimersByTime(4000);
      }
      expect(failed).toEqual([["s1", handle, expect.stringContaining("renderer crashed")]]);
      const next = sources.open("s1", "https://a.test", 100, 100, 30);
      sources.close("s1", handle);
      expect(win(1).destroyed).toBe(false);
      sources.close("s1", next);
      expect(win(1).destroyed).toBe(true);
    });
  });

  describe("loopback blocking", () => {
    // The session's onBeforeRequest listener is registered once, the first time any test
    // in this file opens a source (see the "configures the session once" test above);
    // it is shared by every source ever opened against this module's singleton session.
    function fire(url: string): { cancel?: boolean } {
      const listener = h.session.onBeforeRequest[0] as (
        details: { url: string },
        cb: (r: { cancel?: boolean }) => void,
      ) => void;
      let result: { cancel?: boolean } | undefined;
      listener({ url }, (r) => (result = r));
      return result!;
    }

    it("registers exactly one onBeforeRequest listener for the whole session", () => {
      sources.open("s1", "https://a.test", 100, 100, 30);
      expect(h.session.onBeforeRequest).toHaveLength(1);
    });

    it("allows requests to non-loopback hosts", () => {
      sources.open("s1", "https://a.test", 100, 100, 30);
      expect(fire("https://cdn.example.com/img.png").cancel).not.toBe(true);
      expect(fire("https://a.test/page").cancel).not.toBe(true);
    });

    it("cancels loopback requests when no open source targets that host:port", () => {
      sources.open("s1", "https://a.test", 100, 100, 30);
      for (const url of ["http://127.0.0.1:9222/x", "http://localhost:3000/x", "http://[::1]:9/x", "http://sub.localhost/x"]) {
        expect(fire(url).cancel).toBe(true);
      }
    });

    it("allows loopback requests to a source's own loopback URL, on that host:port only", () => {
      sources.open("s1", "http://127.0.0.1:7000/page", 100, 100, 30);
      expect(fire("http://127.0.0.1:7000/asset.js").cancel).not.toBe(true);
      // Different port on the same loopback host is still blocked.
      expect(fire("http://127.0.0.1:9999/x").cancel).toBe(true);
      // A different loopback host is still blocked.
      expect(fire("http://localhost:7000/x").cancel).toBe(true);
    });

    it("matches hostnames case-insensitively", () => {
      sources.open("s1", "http://LocalHost:7000/page", 100, 100, 30);
      expect(fire("http://localhost:7000/x").cancel).not.toBe(true);
      expect(fire("HTTP://LOCALHOST:7000/x").cancel).not.toBe(true);
    });

    it("falls back to the protocol's default port when none is given", () => {
      sources.open("s1", "http://127.0.0.1/page", 100, 100, 30);
      expect(fire("http://127.0.0.1/asset.js").cancel).not.toBe(true);
      expect(fire("http://127.0.0.1:80/asset.js").cancel).not.toBe(true);
      expect(fire("http://127.0.0.1:81/asset.js").cancel).toBe(true);
    });

    it("revokes the allowance once the source is closed", () => {
      sources.open("s1", "http://127.0.0.1:7000/page", 100, 100, 30);
      expect(fire("http://127.0.0.1:7000/x").cancel).not.toBe(true);
      sources.close("s1");
      expect(fire("http://127.0.0.1:7000/x").cancel).toBe(true);
    });

    it("keeps another source's allowance when one loopback source closes", () => {
      sources.open("s1", "http://127.0.0.1:7000/page", 100, 100, 30);
      sources.open("s2", "http://127.0.0.1:7001/page", 100, 100, 30);
      sources.close("s1");
      expect(fire("http://127.0.0.1:7001/x").cancel).not.toBe(true);
      expect(fire("http://127.0.0.1:7000/x").cancel).toBe(true);
    });

    it("re-opening a source with a non-loopback URL revokes its earlier loopback allowance", () => {
      sources.open("s1", "http://127.0.0.1:7000/page", 100, 100, 30);
      sources.open("s1", "https://a.test", 100, 100, 30);
      expect(fire("http://127.0.0.1:7000/x").cancel).toBe(true);
    });

    it("cancels requests it cannot parse as a URL", () => {
      sources.open("s1", "https://a.test", 100, 100, 30);
      expect(fire("not a url").cancel).toBe(true);
    });
  });
});
