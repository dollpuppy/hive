import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";
import { iceServersFromTurn, sourceInfoFromConfig } from "../shared/source-info";
import { installDisplayMediaHandler, isFromPublisher } from "./capture/display-media";
import { loadConfig, saveConfig, type HiveConfig } from "./config/config-store";
import { Hub } from "./hub/hub";
import { joinPartner, type JoinHandle } from "./hub/joiner";
import { startLocalServer, type LocalServer } from "./hub/local-server";
import { viewerRoute } from "./hub/static-files";
import { generateSecret } from "./invite";
import { forwardPublisherEvents, registerPublisherIpc } from "./publisher-ipc";
import { createPublisherWindow, rendererDevUrl } from "./publisher-window";
import { SpoutInputs } from "./spout/spout-inputs";
import { desiredOutputs } from "./spout/spout-output-plan";
import { SpoutOutputs } from "./spout/spout-outputs";
import { UrlSources } from "./url-sources";

export interface AppCore {
  config: HiveConfig;
  hub: Hub;
  server: LocalServer;
  publisher: BrowserWindow;
  inviteSecret: string;
  configPath: string;
  /** The `--join=` link attempt, if any (stopped by shutdown()). */
  join: JoinHandle | null;
  spoutInputs: SpoutInputs;
  urlSources: UrlSources;
  spoutOutputs: SpoutOutputs;
  /**
   * Stops joining, tears down Spout outputs, URL sources and Spout inputs, disconnects
   * the partner, closes the Publisher window and the server. Idempotent.
   */
  shutdown(): Promise<void>;
}

/**
 * Extra Origins allowed on /local/viewer: only the renderer dev server, when running
 * under it. `file://` is deliberately not allowed: any local HTML file in any Chromium
 * browser sends that Origin and could otherwise watch partner streams and receive
 * TURN credentials. The Publisher (a file: page) uses the token-protected
 * /local/publisher, which has no Origin check.
 */
export function viewerDevOrigins(): string[] {
  const dev = rendererDevUrl();
  return dev ? [new URL(dev).origin] : [];
}

export async function startAppCore(argv: string[]): Promise<AppCore> {
  const configPath = join(app.getPath("userData"), "config.json");
  let config = await loadConfig(configPath);
  const inviteSecret = config.keepSecret && config.secret ? config.secret : generateSecret();
  if (config.keepSecret && !config.secret) {
    config = { ...config, secret: inviteSecret };
    await saveConfig(configPath, config);
  } else if (!config.keepSecret && config.secret !== null) {
    // A secret that isn't being kept must not linger on disk.
    config = { ...config, secret: null };
    await saveConfig(configPath, config);
  }

  const hub = new Hub({
    displayName: config.displayName,
    getInviteSecret: () => inviteSecret,
    getIceServers: () => iceServersFromTurn(config.turn),
  });
  hub.setLocalSources(config.sources.map((s) => sourceInfoFromConfig(s, "idle")));

  const publisherToken = randomBytes(24).toString("base64url");
  const server = await startLocalServer({
    hub,
    publisherToken,
    extraOrigins: viewerDevOrigins(),
    httpRoutes: [viewerRoute(join(__dirname, "../viewer"))],
  });

  hub.on("partner", (p) => console.log(`[hive] partner: ${p ? `${p.name} (${p.sources.length} sources)` : "none"}`));
  hub.on("health", (struggling: boolean) => console.log(`[hive] upload struggling: ${struggling}`));
  hub.on("publisher", (connected: boolean) => console.log(`[hive] publisher ${connected ? "connected" : "disconnected"}`));

  // Handlers are registered in the same tick the window starts loading, before its page can invoke them.
  const publisher = createPublisherWindow({ port: server.port, token: publisherToken });
  const publisherContents = publisher.webContents;
  ipcMain.handle("hive:publisher:get-sources", (event) => {
    if (!isFromPublisher(publisherContents, event)) throw new Error("forbidden");
    return config.sources;
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
  // NOTE(Plan 4): `config` is reassigned (`let`); the closure reads the current value.
  // A single config store should replace this once the dashboard edits config.
  registerPublisherIpc({
    ipcMain,
    isFromPublisher: (event) => isFromPublisher(publisherContents, event),
    sources: () => config.sources,
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
  publisherContents.on("render-process-gone", closePublisherFeeds);

  // Spout outputs: one sender per enabled partner source, re-synced whenever the partner
  // attaches, detaches or changes its source list.
  const spoutOutputs = new SpoutOutputs(
    () => `http://127.0.0.1:${server.port}`,
    (key, err) => console.error(`[hive] spout output ${key}:`, err.message),
  );
  const syncSpoutOutputs = (): void => void spoutOutputs.sync(desiredOutputs(hub.partner, config.spoutOut));
  hub.on("partner", syncSpoutOutputs);
  syncSpoutOutputs();

  console.log(`[hive] local server http://127.0.0.1:${server.port}`);
  // The invite carries the secret; only print it in development.
  if (!app.isPackaged) console.log(`[hive] local invite  http://127.0.0.1:${server.port}/join#${inviteSecret}`);

  const joinArg = argv.find((a) => a.startsWith("--join="));
  const joinHandle = joinArg
    ? joinPartner({
        hub,
        invite: joinArg.slice("--join=".length),
        onStatus: (s, d) => console.log(`[hive] join: ${s}${d ? ` (${d})` : ""}`),
      })
    : null;

  let shuttingDown: Promise<void> | null = null;
  const core: AppCore = {
    config,
    hub,
    server,
    publisher,
    inviteSecret,
    configPath,
    join: joinHandle,
    spoutInputs,
    urlSources,
    spoutOutputs,
    shutdown: () => {
      shuttingDown ??= (async () => {
        // Stop the joiner first: hub.dispose() emits `partner: null`, which a live joiner
        // would answer by scheduling a reconnect.
        core.join?.stop();
        core.join = null;
        // Spout outputs next: their offscreen viewer pages talk to the server and hub,
        // and must not react to the partner leaving. Then everything forwarding into the
        // Publisher, before the hub and the Publisher window go away.
        spoutOutputs.disposeAll();
        urlSources.dispose();
        spoutInputs.dispose();
        hub.dispose();
        if (!publisher.isDestroyed()) publisher.destroy();
        await server.close();
      })();
      return shuttingDown;
    },
  };
  return core;
}
