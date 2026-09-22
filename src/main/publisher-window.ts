import { join } from "node:path";
import { app, BrowserWindow } from "electron";

export interface PublisherWindowOptions {
  port: number;
  token: string;
}

/** Renderer dev-server URL set by `electron-vite dev`; ignored in packaged builds. */
export function rendererDevUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL || undefined;
}

const RELOAD_BASE_DELAY_MS = 1000;
const RELOAD_MAX_DELAY_MS = 30_000;
/** A reload that stays up this long resets the backoff. */
const STABLE_MS = 30_000;
const CRASH_WINDOW_MS = 120_000;
const MAX_CRASHES = 5;

export function createPublisherWindow(opts: PublisherWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/publisher.js"),
      // Required by texture-bridge's installSharedTextureReceiver/consumeSharedTexture (Plan 3).
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      // Hidden window must keep timers, rAF and WebRTC running.
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;

  // The page has Node access: it must never leave our own publisher page or open other windows.
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("will-redirect", (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: "deny" }));

  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[hive] publisher page failed to load: ${code} ${description} (${url})`);
  });
  wc.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") {
      console.error(`[hive] publisher ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
    }
  });

  const load = (): void => {
    const query = { port: String(opts.port), token: opts.token };
    const devUrl = rendererDevUrl();
    const loading = devUrl
      ? win.loadURL(`${devUrl}/publisher/index.html?${new URLSearchParams(query).toString()}`)
      : win.loadFile(join(__dirname, "../renderer/publisher/index.html"), { query });
    // Failures are reported by did-fail-load.
    loading.catch(() => undefined);
  };

  // Crash recovery: reload with exponential backoff; the backoff resets once a reload has
  // stayed up for STABLE_MS; too many crashes in CRASH_WINDOW_MS and we stop trying.
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = RELOAD_BASE_DELAY_MS;
  let crashes: number[] = [];
  let gaveUp = false;
  const clearTimers = (): void => {
    if (reloadTimer) clearTimeout(reloadTimer);
    if (stableTimer) clearTimeout(stableTimer);
    reloadTimer = stableTimer = null;
  };

  wc.on("did-finish-load", () => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = null;
      delay = RELOAD_BASE_DELAY_MS;
    }, STABLE_MS);
  });
  wc.on("render-process-gone", (_e, details) => {
    if (gaveUp) return;
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
    const now = Date.now();
    crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (crashes.length >= MAX_CRASHES) {
      gaveUp = true;
      clearTimers();
      console.error(
        `[hive] publisher renderer gone (${details.reason}, exit ${details.exitCode}); ` +
          `${crashes.length} crashes in ${CRASH_WINDOW_MS / 1000} s — giving up, publishing is stopped until restart`,
      );
      return;
    }
    if (reloadTimer) return;
    console.error(
      `[hive] publisher renderer gone (${details.reason}, exit ${details.exitCode}); reloading in ${delay / 1000} s`,
    );
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (!win.isDestroyed()) load();
    }, delay);
    delay = Math.min(delay * 2, RELOAD_MAX_DELAY_MS);
  });
  win.on("closed", clearTimers);

  load();
  return win;
}
