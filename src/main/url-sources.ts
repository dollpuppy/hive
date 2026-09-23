import { BrowserWindow, session, type Session, type Streams, type WebContents } from "electron";
import { forwardSharedTexture } from "@napolab/texture-bridge-core/electron";

/** Non-persistent (no `persist:` prefix) session shared by every URL source. */
export const URL_SOURCES_PARTITION = "hive-url-sources";

/** First retry delay after a crash or failed load; doubles per failure in the window. */
const RETRY_BASE_MS = 1000;
/** Failures older than this no longer count towards the cap. */
const RETRY_WINDOW_MS = 60_000;
/** More failures than this within the window and the source stops retrying. */
const MAX_RETRIES_PER_WINDOW = 3;
/** Chromium's ERR_ABORTED: a navigation superseded by another, not a failure. */
const ERR_ABORTED = -3;
/**
 * Offscreen windows only paint on change, so a static page would send one frame
 * and then nothing; invalidating this often keeps late joiners supplied.
 */
const INVALIDATE_INTERVAL_MS = 1000;
const MAX_ID_CHARS = 256;
const MAX_DIMENSION = 8192;
const MAX_FPS = 240;

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function requireSize(value: number, what: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`invalid ${what}`);
  return value;
}

function stopInvalidating(entry: { invalidateTimer: ReturnType<typeof setInterval> | null }): void {
  if (entry.invalidateTimer) clearInterval(entry.invalidateTimer);
  entry.invalidateTimer = null;
}

let configuredSession: Session | null = null;

/**
 * The URL-source session, locked down once: remote pages get no permissions,
 * no display capture, and no downloads. Lazy because sessions need app ready.
 */
function urlSourcesSession(): Session {
  if (configuredSession) return configuredSession;
  const ses = session.fromPartition(URL_SOURCES_PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    try {
      // Electron's docs deny with callback(null); its typings only admit Streams.
      callback(null as unknown as Streams);
    } catch (err) {
      console.error("[hive] url-source display-media deny failed:", err);
    }
  });
  ses.on("will-download", (_event, item) => item.cancel());
  configuredSession = ses;
  return ses;
}

interface UrlSource {
  readonly handle: number;
  readonly win: BrowserWindow;
  drops: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Times of recent crashes/failed loads, for the retry backoff and cap. */
  failures: number[];
  invalidateTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Renders URL sources in offscreen windows and forwards each paint texture
 * zero-copy to the Publisher, tagged with extraArgs [sourceId]. Each source gets
 * its own sandboxed window in an isolated session: the Publisher runs with
 * nodeIntegration and must never load remote content itself.
 */
export class UrlSources {
  private readonly sources = new Map<string, UrlSource>();
  private nextHandle = 1;

  constructor(private readonly target: () => WebContents | null) {}

  /**
   * Opens (or replaces) the source's window. Throws on invalid input (including any
   * non-http(s) URL); crashes and failed loads are retried with backoff. Returns a handle identifying
   * this open, for `close(sourceId, handle)`.
   */
  open(sourceId: string, url: string, width: number, height: number, fps: number): number {
    if (typeof sourceId !== "string" || sourceId === "" || sourceId.length > MAX_ID_CHARS) {
      throw new Error("invalid sourceId");
    }
    if (typeof url !== "string" || !isWebUrl(url)) throw new Error("URL sources must be http(s)");
    requireSize(width, "width", MAX_DIMENSION);
    requireSize(height, "height", MAX_DIMENSION);
    requireSize(fps, "fps", MAX_FPS);
    this.close(sourceId);

    const win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      webPreferences: {
        session: urlSourcesSession(),
        offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    });
    const entry: UrlSource = { handle: this.nextHandle++, win, drops: 0, retryTimer: null, failures: [], invalidateTimer: null };
    this.sources.set(sourceId, entry); // registered first so close() can always reach the window
    const wc = win.webContents;
    const isCurrent = (): boolean => this.sources.get(sourceId) === entry;

    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => {
      if (!isWebUrl(event.url)) event.preventDefault();
    });
    wc.on("will-redirect", (event) => {
      if (!isWebUrl(event.url)) event.preventDefault();
    });
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.setAudioMuted(true);

    // Synchronous handler; forward is fire-and-forget (its import + send dispatch run
    // before its first await, so releasing in finally is safe); release in finally.
    wc.on("paint", (event) => {
      const texture = event.texture;
      if (!texture) return;
      try {
        const target = this.target();
        if (target && !target.isDestroyed()) {
          // Resolves a ForwardDefect or undefined; never rejects. A defect is a
          // dropped frame, counted rather than reported.
          void forwardSharedTexture(texture.textureInfo, target, [sourceId]).then((defect) => {
            if (defect && isCurrent()) entry.drops += 1;
          });
        }
      } finally {
        texture.release();
      }
    });

    const load = (): void => {
      // A main-frame failure also fires did-fail-load, which schedules the retry.
      wc.loadURL(url).catch((err: unknown) => {
        console.warn(`[hive] url source ${sourceId} loadURL failed:`, err);
      });
    };
    // One retry pending at a time. Each failure within RETRY_WINDOW_MS doubles the
    // delay (1 s, 2 s, 4 s); a fourth failure within the window gives up.
    const scheduleRetry = (retry: () => void): void => {
      if (!isCurrent() || entry.retryTimer) return;
      const now = Date.now();
      entry.failures = entry.failures.filter((t) => now - t < RETRY_WINDOW_MS);
      entry.failures.push(now);
      const n = entry.failures.length;
      if (n > MAX_RETRIES_PER_WINDOW) {
        console.error(`[hive] url source ${sourceId}: ${n} failures within ${RETRY_WINDOW_MS / 1000} s, giving up`);
        return;
      }
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        if (isCurrent() && !win.isDestroyed()) retry();
      }, RETRY_BASE_MS * 2 ** (n - 1));
    };

    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      console.warn(`[hive] url source ${sourceId} failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
      scheduleRetry(load);
    });
    wc.on("render-process-gone", (_event, details) => {
      console.error(`[hive] url source ${sourceId} renderer gone: ${details.reason} (${details.exitCode})`);
      scheduleRetry(() => wc.reload());
    });

    const invalidate = (): void => {
      if (!win.isDestroyed()) wc.invalidate();
    };
    wc.on("did-finish-load", invalidate);
    entry.invalidateTimer = setInterval(invalidate, INVALIDATE_INTERVAL_MS);
    wc.once("destroyed", () => stopInvalidating(entry));

    wc.setFrameRate(fps);
    load();
    return entry.handle;
  }

  /**
   * Destroys the source's window. With a `handle`, only closes if that open is still
   * the current one, so a late close from a superseded open cannot kill its successor.
   * Without one, closes unconditionally.
   */
  close(sourceId: string, handle?: number): void {
    const entry = this.sources.get(sourceId);
    if (!entry) return;
    if (handle !== undefined && entry.handle !== handle) return;
    this.sources.delete(sourceId);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    stopInvalidating(entry);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  droppedFrames(sourceId: string): number {
    return this.sources.get(sourceId)?.drops ?? 0;
  }

  dispose(): void {
    for (const id of [...this.sources.keys()]) this.close(id);
  }
}

