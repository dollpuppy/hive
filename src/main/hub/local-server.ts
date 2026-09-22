import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { MAX_MESSAGE_CHARS } from "../../shared/protocol";
import { secretsEqual } from "../invite";
import type { Channel, ChannelHandler } from "./channel";
import type { Hub } from "./hub";

export const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 7420 + i);

/** Paths reachable through the Cloudflare tunnel. Everything else is local-only. */
const TUNNEL_HTTP_PATHS = new Set(["/join"]);

export interface RouteContext {
  viaTunnel: boolean;
  path: string;
  port: number;
}

/** Return true when the route handled the request. */
export type HttpRoute = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => boolean;

export interface LocalServerOptions {
  hub: Hub;
  publisherToken: string;
  ports?: number[];
  extraOrigins?: string[];
  httpRoutes?: HttpRoute[];
}

export interface LocalServer {
  readonly port: number;
  close(): Promise<void>;
}

export function isViaTunnel(req: IncomingMessage): boolean {
  return req.headers["cf-connecting-ip"] !== undefined;
}

export function wsChannel(ws: WebSocket): Channel {
  return {
    send: (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

export function bindSocket(ws: WebSocket, handler: ChannelHandler): void {
  ws.on("message", (data, isBinary) => {
    if (!isBinary) handler.onMessage(data.toString());
  });
  ws.on("close", () => handler.onClose());
  ws.on("error", () => ws.terminate());
}

function refuse(socket: Duplex, status: 403 | 404): void {
  socket.write(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function listenOnFirstFree(server: http.Server, ports: number[]): Promise<number> {
  for (const port of ports) {
    const ok = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE") resolve(false);
        else reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (ok) return (server.address() as AddressInfo).port;
  }
  throw new Error(`No free port in ${ports.join(", ")}`);
}

export async function startLocalServer(opts: LocalServerOptions): Promise<LocalServer> {
  let port = 0;
  const allowedOrigin = (origin: string | undefined): boolean =>
    origin === undefined ||
    origin === `http://127.0.0.1:${port}` ||
    origin === `http://localhost:${port}` ||
    (opts.extraOrigins ?? []).includes(origin);

  const server = http.createServer((req, res) => {
    const viaTunnel = isViaTunnel(req);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (viaTunnel && !TUNNEL_HTTP_PATHS.has(path)) {
      res.writeHead(404).end();
      return;
    }
    for (const route of opts.httpRoutes ?? []) {
      if (route(req, res, { viaTunnel, path, port })) return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_CHARS });
  const accept = (req: IncomingMessage, socket: Duplex, head: Buffer, attach: (c: Channel) => ChannelHandler) =>
    wss.handleUpgrade(req, socket, head, (ws) => bindSocket(ws, attach(wsChannel(ws))));

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/hub") {
      accept(req, socket, head, (c) => opts.hub.attachIncomingPeer(c));
      return;
    }
    if (isViaTunnel(req)) return refuse(socket, 404);
    if (url.pathname === "/local/viewer") {
      if (!allowedOrigin(req.headers.origin)) return refuse(socket, 403);
      accept(req, socket, head, (c) => opts.hub.attachViewer(c));
      return;
    }
    if (url.pathname === "/local/publisher") {
      // Token-protected; the Publisher page's Origin is file:// (or the dev server), so no Origin check.
      const token = url.searchParams.get("token") ?? "";
      if (!secretsEqual(opts.publisherToken, token)) return refuse(socket, 403);
      accept(req, socket, head, (c) => opts.hub.attachPublisher(c));
      return;
    }
    refuse(socket, 404);
  });

  port = await listenOnFirstFree(server, opts.ports ?? DEFAULT_PORTS);

  return {
    get port() {
      return port;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
