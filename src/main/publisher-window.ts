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

const RELOAD_DELAY_MS = 1000;

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

  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  wc.on("render-process-gone", (_e, details) => {
    console.error(`[hive] publisher renderer gone (${details.reason}, exit ${details.exitCode}); reloading`);
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (!win.isDestroyed()) load();
    }, RELOAD_DELAY_MS);
  });
  win.on("closed", () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
  });

  load();
  return win;
}
