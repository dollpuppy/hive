import { EventEmitter } from "node:events";
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

let configuredSession: Session | null = null;

/**
 * Loopback allowance per currently-open source whose own configured URL is itself
 * loopback, keyed by sourceId so a close() or a reopen with a different URL can revoke
 * just that source's entry without disturbing anyone else's. `webContentsId` attributes
 * an incoming request back to the one source that opened it (Electron's
 * `OnBeforeRequestListenerDetails.webContentsId` names the requesting webContents), so
 * source B (a remote, possibly hostile page) can never ride source A's allowance to
 * reach A's loopback target — only A's own window can. All URL sources share a single
 * session (URL_SOURCES_PARTITION), so this registry backs a single onBeforeRequest
 * listener registered once for that session — Electron keeps only the most recently
 * registered listener per event per session, so per-source registration would silently
 * clobber earlier sources' listeners instead of composing with them.
 */
const loopbackAllow = new Map<string, { webContentsId: number; target: string }>();

/** Strips IPv6 brackets, a trailing root "." (DNS-legal, `localhost.` bypasses a naive match), and lowercases. */
function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function isIPv4Loopback(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null || !m.slice(1).every((o) => Number(o) <= 255)) return false;
  return m[1] === "127" || host === "0.0.0.0";
}

/**
 * If `host` is an IPv6 address with an embedded IPv4 address (the `::ffff:a.b.c.d`
 * mapped form, either as a dotted quad or — what `new URL()` actually normalizes it
 * to — two hex groups, e.g. `::ffff:7f00:1` for 127.0.0.1), returns that IPv4 address
 * in dotted-quad form; otherwise null.
 */
function ipv4MappedAddress(host: string): string | null {
  const m = /^::ffff:(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
  if (m === null) return null;
  if (m[1]) return m[1];
  const hi = Number.parseInt(m[2]!, 16);
  const lo = Number.parseInt(m[3]!, 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
}

/** 127.0.0.0/8, 0.0.0.0, localhost, *.localhost, the IPv6 loopback address, and any IPv4-mapped form of the above. */
function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (isIPv4Loopback(host)) return true;
  const mapped = ipv4MappedAddress(host);
  return mapped !== null && isIPv4Loopback(mapped);
}

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Normalized "host:port" for a URL, filling in the scheme's default port when absent.
 * An IPv4-mapped IPv6 host is folded to its plain IPv4 form, so a source's own URL and
 * an incoming request that name the same address in different notations still match.
 */
function hostPort(u: URL): string {
  const host = normalizeHost(u.hostname);
  return `${ipv4MappedAddress(host) ?? host}:${u.port || (DEFAULT_PORT[u.protocol] ?? "")}`;
}

/**
 * Records or clears sourceId's loopback allowance from its configured URL: an http(s)
 * source that itself points at a loopback host may only ever reach that one host:port,
 * from that source's own window — even though the session it renders in is shared with
 * every other URL source.
 */
function setLoopbackAllowance(sourceId: string, url: string, webContentsId: number): void {
  const u = new URL(url); // caller already validated this is a well-formed http(s) URL
  if (isLoopbackHost(normalizeHost(u.hostname))) loopbackAllow.set(sourceId, { webContentsId, target: hostPort(u) });
  else loopbackAllow.delete(sourceId);
}

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
  // Blocks every loopback request from every URL source (the whole session's traffic,
  // since Electron only keeps the last-registered onBeforeRequest listener per session)
  // unless it targets the exact host:port of the *requesting* source's own loopback URL
  // (attributed via webContentsId — see loopbackAllow's doc comment). Without this, a
  // malicious or compromised remote page loaded as a URL source could probe or attack
  // services on the user's own machine (other Hive ports, other localhost apps) using
  // the renderer's network stack — either its own, or another source's if allowance
  // were not scoped per-window.
  ses.webRequest.onBeforeRequest((details, callback) => {
    let u: URL;
    try {
      u = new URL(details.url);
    } catch {
      callback({ cancel: true });
      return;
    }
    if (!isLoopbackHost(normalizeHost(u.hostname))) {
      callback({});
      return;
    }
    const target = hostPort(u);
    const owner = [...loopbackAllow.values()].find((a) => a.webContentsId === details.webContentsId);
    callback({ cancel: owner?.target !== target });
  });
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
}

/**
 * Renders URL sources in offscreen windows and forwards each paint texture
 * zero-copy to the Publisher, tagged with extraArgs [sourceId]. Each source gets
 * its own sandboxed window in an isolated session: the Publisher runs with
 * nodeIntegration and must never load remote content itself.
 *
 * Emits "failed" (sourceId, handle, reason) once when an open gives up retrying
 * (more than 3 crashes/failed loads within 60 s); its window is then destroyed and
 * the open forgotten, so a later close with that handle is a no-op.
 */
export class UrlSources extends EventEmitter {
  private readonly sources = new Map<string, UrlSource>();
  private nextHandle = 1;

  constructor(private readonly target: () => WebContents | null) {
    super();
  }

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
        disableDialogs: true,
        backgroundThrottling: false,
      },
    });
    const entry: UrlSource = { handle: this.nextHandle++, win, drops: 0, retryTimer: null, failures: [] };
    this.sources.set(sourceId, entry); // registered first so close() can always reach the window
    const wc = win.webContents;
    setLoopbackAllowance(sourceId, url, wc.id);
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
    const scheduleRetry = (reason: string, retry: () => void): void => {
      if (!isCurrent() || entry.retryTimer) return;
      const now = Date.now();
      entry.failures = entry.failures.filter((t) => now - t < RETRY_WINDOW_MS);
      entry.failures.push(now);
      const n = entry.failures.length;
      if (n > MAX_RETRIES_PER_WINDOW) {
        console.error(`[hive] url source ${sourceId}: ${n} failures within ${RETRY_WINDOW_MS / 1000} s, giving up`);
        this.giveUp(sourceId, entry, `${n} failures within ${RETRY_WINDOW_MS / 1000} s (last: ${reason})`);
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
      scheduleRetry(`${errorDescription} (${errorCode})`, load);
    });
    wc.on("render-process-gone", (_event, details) => {
      console.error(`[hive] url source ${sourceId} renderer gone: ${details.reason} (${details.exitCode})`);
      scheduleRetry(`renderer ${details.reason}`, () => wc.reload());
    });

    // A repeating invalidate() here (tried previously) does not, in practice, make
    // Chromium's offscreen compositor emit new `paint` events for an unchanged page;
    // only this one-shot after load actually produces a paint. Late joiners and static
    // pages are instead kept alive downstream, by the Publisher's idle-refresh keepalive
    // re-sending the last frame it received (see gpu-openers.ts's idleRefresher).
    wc.on("did-finish-load", () => {
      if (!win.isDestroyed()) wc.invalidate();
    });

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
    loopbackAllow.delete(sourceId);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  /**
   * Forgets a source that stopped retrying and reports it "failed". The window is
   * destroyed on the next tick, not inside the webContents event that got us here.
   */
  private giveUp(sourceId: string, entry: UrlSource, reason: string): void {
    if (this.sources.get(sourceId) !== entry) return;
    this.sources.delete(sourceId);
    loopbackAllow.delete(sourceId);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    setTimeout(() => {
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }, 0);
    this.emit("failed", sourceId, entry.handle, reason);
  }

  droppedFrames(sourceId: string): number {
    return this.sources.get(sourceId)?.drops ?? 0;
  }

  /** Destroys every source's window. The instance stays usable (see dispose()). */
  closeAll(): void {
    for (const id of [...this.sources.keys()]) this.close(id);
  }

  /** Same as closeAll(): nothing else is held, so the instance remains usable. */
  dispose(): void {
    this.closeAll();
  }
}

