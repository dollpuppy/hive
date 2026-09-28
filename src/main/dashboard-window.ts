import { join } from "node:path";
import { BrowserWindow, screen } from "electron";
import type { HiveConfig } from "./config/config-store";
import { rendererDevUrl } from "./publisher-window";
import { fitSavedBounds } from "./window-bounds";

/** Prefix the local server serves the built renderer directory at (see app-core). */
export const DASHBOARD_UI_PREFIX = "/ui/";

/**
 * The dashboard page URL: the renderer dev server under `electron-vite dev`, otherwise the
 * built page served over http by the local server. Not file://: the dashboard's previews
 * connect to /local/viewer, whose Origin check deliberately rejects file:// pages.
 */
export function dashboardUrl(port: number): string {
  const dev = rendererDevUrl();
  return dev ? `${dev}/dashboard/index.html` : `http://127.0.0.1:${port}${DASHBOARD_UI_PREFIX}dashboard/index.html`;
}

const stripHash = (url: string): string => url.split("#")[0]!;

export function createDashboardWindow(opts: { url: string; bounds: HiveConfig["windowBounds"] }): BrowserWindow {
  // Saved bounds may be on a display that's gone: then it centers, sized to fit the primary one.
  const bounds = opts.bounds
    ? fitSavedBounds(
        opts.bounds,
        screen.getAllDisplays().map((d) => d.workArea),
        screen.getPrimaryDisplay().workArea,
      )
    : null;
  const win = new BrowserWindow({
    width: bounds?.width ?? 980,
    height: bounds?.height ?? 680,
    ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 520,
    title: "Hive",
    backgroundColor: "#0f1113",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/dashboard.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const wc = win.webContents;

  // The page holds the whole dashboard API: it must stay on its own page and open no windows.
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => {
    if (stripHash(e.url) !== stripHash(opts.url)) e.preventDefault();
  });
  wc.on("will-redirect", (e) => e.preventDefault());

  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[hive] dashboard page failed to load: ${code} ${description} (${url})`);
  });
  wc.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") {
      console.error(`[hive] dashboard ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
    }
  });
  wc.on("render-process-gone", (_e, details) => {
    console.error(`[hive] dashboard renderer gone (${details.reason}, exit ${details.exitCode})`);
  });

  // Failures are reported by did-fail-load.
  win.loadURL(opts.url).catch(() => undefined);
  return win;
}
