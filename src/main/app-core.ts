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
import { createPublisherWindow, rendererDevUrl } from "./publisher-window";

export interface AppCore {
  config: HiveConfig;
  hub: Hub;
  server: LocalServer;
  publisher: BrowserWindow;
  inviteSecret: string;
  configPath: string;
  /** The `--join=` link attempt, if any (stopped by shutdown()). */
  join: JoinHandle | null;
  /** Stops joining, disconnects the partner, closes the server and the Publisher window. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Extra Origins allowed on /local/viewer: our own file:// pages (Chromium sends
 * `Origin: file://` on a WebSocket handshake from a file: page) and the dev server.
 */
export function devOrigins(): string[] {
  const dev = rendererDevUrl();
  return ["file://", ...(dev ? [new URL(dev).origin] : [])];
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
    extraOrigins: devOrigins(),
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
    shutdown: () => {
      shuttingDown ??= (async () => {
        // Stop the joiner first: hub.dispose() emits `partner: null`, which a live joiner
        // would answer by scheduling a reconnect.
        core.join?.stop();
        core.join = null;
        hub.dispose();
        if (!publisher.isDestroyed()) publisher.destroy();
        await server.close();
      })();
      return shuttingDown;
    },
  };
  return core;
}
