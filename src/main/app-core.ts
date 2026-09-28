import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { app, clipboard, ipcMain, type BrowserWindow } from "electron";
import type { DashboardState } from "../shared/dashboard-api";
import { iceServersFromTurn, sourceInfoFromConfig } from "../shared/source-info";
import {
  installDisplayMediaHandler,
  isFromMainFrameOf,
  isFromPublisher,
  listCapturableWindows,
} from "./capture/display-media";
import { loadConfig, saveConfig } from "./config/config-store";
import { registerDashboardIpc } from "./dashboard-ipc";
import { createDashboardWindow, DASHBOARD_UI_PREFIX, dashboardUrl } from "./dashboard-window";
import { Hub } from "./hub/hub";
import { joinRoute } from "./hub/join-page";
import { joinPartner } from "./hub/joiner";
import { startLocalServer, type LocalServer } from "./hub/local-server";
import { staticRoute, viewerRoute } from "./hub/static-files";
import { forwardPublisherEvents, registerPublisherIpc } from "./publisher-ipc";
import { createPublisherWindow, rendererDevUrl } from "./publisher-window";
import { SessionController } from "./session/session-controller";
import { SpoutInputs } from "./spout/spout-inputs";
import { desiredOutputs } from "./spout/spout-output-plan";
import { SpoutOutputs } from "./spout/spout-outputs";
import { TunnelManager } from "./tunnel/tunnel-manager";
import { UrlSources } from "./url-sources";

export interface AppCore {
  /** The single config store; also owns hosting (tunnel + invite secret) and joining. */
  session: SessionController;
  hub: Hub;
  server: LocalServer;
  publisher: BrowserWindow;
  dashboard: BrowserWindow;
  configPath: string;
  spoutInputs: SpoutInputs;
  urlSources: UrlSources;
  spoutOutputs: SpoutOutputs;
  tunnel: TunnelManager;
  /** Shows the dashboard (restored and focused), e.g. when a second instance is launched. */
  focus(): void;
  /**
   * Stops joining and the tunnel, tears down Spout outputs, URL sources and Spout inputs,
   * disconnects the partner, closes the windows and the server. Idempotent.
   */
  shutdown(): Promise<void>;
}

/**
 * Extra Origins allowed on /local/viewer: only the renderer dev server, when running
 * under it. `file://` is deliberately not allowed: any local HTML file in any Chromium
 * browser sends that Origin and could otherwise watch partner streams and receive
 * TURN credentials. The Publisher (a file: page) uses the token-protected
 * /local/publisher, which has no Origin check. The dashboard is served over http by the
 * local server itself (same origin), or by the dev server.
 */
export function viewerDevOrigins(): string[] {
  const dev = rendererDevUrl();
  return dev ? [new URL(dev).origin] : [];
}

/** cloudflared.exe: shipped as an extra resource when packaged; `resources/` in the repo otherwise. */
export function cloudflaredPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "cloudflared.exe")
    : join(app.getAppPath(), "resources", "cloudflared.exe");
}

export async function startAppCore(): Promise<AppCore> {
  const configPath = join(app.getPath("userData"), "config.json");
  const config = await loadConfig(configPath);

  // The Hub needs the controller (secret, ICE servers) and the controller needs the Hub;
  // the Hub only asks on incoming hellos, which can't arrive before the controller exists.
  let controller: SessionController | null = null;
  const hub = new Hub({
    displayName: config.displayName,
    getInviteSecret: () => controller?.inviteSecret ?? null,
    getIceServers: () => controller?.iceServers ?? iceServersFromTurn(config.turn),
  });
  hub.setLocalSources(config.sources.map((s) => sourceInfoFromConfig(s, "idle")));

  const publisherToken = randomBytes(24).toString("base64url");
  const server = await startLocalServer({
    hub,
    publisherToken,
    extraOrigins: viewerDevOrigins(),
    httpRoutes: [
      joinRoute(),
      viewerRoute(join(__dirname, "../viewer")),
      // The built renderer pages (the dashboard). Local-only, like every route but /join.
      staticRoute(DASHBOARD_UI_PREFIX, join(__dirname, "../renderer")),
    ],
  });

  hub.on("partner", (p) => console.log(`[hive] partner: ${p ? `${p.name} (${p.sources.length} sources)` : "none"}`));
  hub.on("health", (struggling: boolean) => console.log(`[hive] upload struggling: ${struggling}`));
  hub.on("publisher", (connected: boolean) => console.log(`[hive] publisher ${connected ? "connected" : "disconnected"}`));

  // Handlers are registered in the same tick the window starts loading, before its page can invoke them.
  const publisher = createPublisherWindow({ port: server.port, token: publisherToken });
  const publisherContents = publisher.webContents;
  ipcMain.handle("hive:publisher:get-sources", (event) => {
    if (!isFromPublisher(publisherContents, event)) throw new Error("forbidden");
    return session.config.sources;
  });
  installDisplayMediaHandler(publisherContents);

  // Never auto-select a client certificate for any page (URL sources load arbitrary
  // configured sites): answering with no certificate continues without one.
  app.on("select-client-certificate", (event, _wc, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });

  // Spout inputs and URL sources deliver frames into the Publisher, tagged by sourceId.
  const publisherTarget = () => (publisher.isDestroyed() ? null : publisherContents);
  const spoutInputs = new SpoutInputs(publisherTarget);
  const urlSources = new UrlSources(publisherTarget);
  forwardPublisherEvents({ target: publisherTarget, spout: spoutInputs, url: urlSources });
  spoutInputs.start();

  // Spout outputs: one sender per enabled partner source. The controller decides when to
  // re-sync (partner attach/detach with a grace period, toggles); a create that fails for
  // good reverts its toggle and is reported inline.
  const spoutOutputs = new SpoutOutputs(
    () => `http://127.0.0.1:${server.port}`,
    (key, err) => {
      console.error(`[hive] spout output ${key}:`, err.message);
      controller?.reportSpoutOutputError(key, err);
    },
  );
  const tunnel = new TunnelManager({ binaryPath: cloudflaredPath() });

  const session = new SessionController({
    config,
    saveConfig: (c) => saveConfig(configPath, c),
    hub,
    port: server.port,
    tunnel,
    join: joinPartner,
    notifyPublisherSources: (sources) => {
      const target = publisherTarget();
      if (target && !target.isDestroyed()) target.send("hive:publisher:sources", sources);
    },
    syncSpoutOutputs: (partner, enabled) => void spoutOutputs.sync(desiredOutputs(partner, enabled)),
  });
  controller = session;

  registerPublisherIpc({
    ipcMain,
    isFromPublisher: (event) => isFromPublisher(publisherContents, event),
    sources: () => session.config.sources,
    spout: spoutInputs,
    url: urlSources,
  });

  // A reloaded or crashed Publisher page no longer holds any of its opens, and
  // SpoutInputs/UrlSources can't tell: drop every receiver and URL window so they stop
  // forwarding into nowhere. The new page re-opens what it needs. (The very first load
  // passes through here too; nothing is open yet, so it is a no-op — which also means
  // nothing depends on catching that first event.) Spout discovery keeps running.
  const closePublisherFeeds = (): void => {
    spoutInputs.closeAll();
    urlSources.closeAll();
  };
  publisherContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) closePublisherFeeds();
  });
  // Again once the navigation commits (did-navigate is main-frame, cross-document
  // only): an open from the old page still in flight at did-start-navigation lands
  // after it. The new page can't have opened anything yet: its opens follow a
  // viewer's acquire over the WebSocket it connects after loading.
  publisherContents.on("did-navigate", closePublisherFeeds);
  publisherContents.on("render-process-gone", closePublisherFeeds);

  // Dashboard: handlers registered in the same tick the window starts loading.
  const dashboard = createDashboardWindow({ url: dashboardUrl(server.port), bounds: config.windowBounds });
  const dashboardContents = dashboard.webContents;
  registerDashboardIpc({
    ipcMain,
    isFromDashboard: (event) => isFromMainFrameOf(dashboardContents, event),
    session,
    listWindows: listCapturableWindows,
    listSpoutSenders: () => spoutInputs.senders(),
    copy: (text) => clipboard.writeText(text),
  });

  // State pushes can arrive after the window is gone (e.g. tunnel.stop() during shutdown).
  let loggedSecret: string | null = null;
  let loggedJoin = "idle";
  session.on("state", (state: DashboardState) => {
    if (!dashboard.isDestroyed() && !dashboardContents.isDestroyed()) {
      dashboardContents.send("hive:dash:state", state);
    }
    const secret = session.inviteSecret;
    // The invite carries the secret; only print it in development.
    if (!app.isPackaged && secret !== null && secret !== loggedSecret) {
      console.log(`[hive] local invite  http://127.0.0.1:${server.port}/join#${secret}`);
    }
    loggedSecret = secret;
    const join = `${state.join.status}${state.join.detail ? ` (${state.join.detail})` : ""}`;
    if (join !== loggedJoin) console.log(`[hive] join: ${join}`);
    loggedJoin = join;
  });

  // Save bounds as the dashboard closes; shutdown waits for the write.
  let boundsSaved: Promise<void> = Promise.resolve();
  const saveBounds = (): void => {
    boundsSaved = session
      .saveWindowBounds(dashboard.getNormalBounds())
      .catch((err: unknown) => console.error("[hive] failed to save window bounds:", err));
  };
  dashboard.on("close", saveBounds);
  // The dashboard is the app: closing it quits (the Publisher window is hidden).
  dashboard.on("closed", () => app.quit());

  console.log(`[hive] local server http://127.0.0.1:${server.port}`);

  let shuttingDown: Promise<void> | null = null;
  const core: AppCore = {
    session,
    hub,
    server,
    publisher,
    dashboard,
    configPath,
    spoutInputs,
    urlSources,
    spoutOutputs,
    tunnel,
    focus: () => {
      if (dashboard.isDestroyed()) return;
      if (dashboard.isMinimized()) dashboard.restore();
      dashboard.show();
      dashboard.focus();
    },
    shutdown: () => {
      shuttingDown ??= (async () => {
        // Stop the joiner (and the tunnel) first: hub.dispose() emits `partner: null`,
        // which a live joiner would answer by scheduling a reconnect.
        session.dispose();
        // Spout outputs next: their offscreen viewer pages talk to the server and hub,
        // and must not react to the partner leaving. Then everything forwarding into the
        // Publisher, before the hub and the Publisher window go away.
        spoutOutputs.disposeAll();
        urlSources.dispose();
        spoutInputs.dispose();
        hub.dispose();
        if (!publisher.isDestroyed()) publisher.destroy();
        if (!dashboard.isDestroyed()) {
          // destroy() skips "close" (quit via Ctrl+C / SIGTERM): save the bounds here instead.
          saveBounds();
          dashboard.destroy();
        }
        await server.close();
        await boundsSaved;
      })();
      return shuttingDown;
    },
  };
  return core;
}
