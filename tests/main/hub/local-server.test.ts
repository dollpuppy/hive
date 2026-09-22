import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Hub } from "../../../src/main/hub/hub";
import { startLocalServer, type LocalServer } from "../../../src/main/hub/local-server";

let server: LocalServer | null = null;
const hub = () => new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });

afterEach(async () => {
  await server?.close();
  server = null;
});

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(d.toString()))));
}

/** Probe whether binding `port` on 127.0.0.1 fails with the given error code (e.g. a reserved/excluded port). */
function probeBindErrorCode(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code));
    probe.once("listening", () => probe.close(() => resolve(undefined)));
    probe.listen(port, "127.0.0.1");
  });
}

/** Send a raw HTTP request over a plain TCP socket and return the full response text. */
function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(raw);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

describe("local server", () => {
  it("listens on 127.0.0.1 and reports the port", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    expect(server.port).toBeGreaterThan(0);
  });

  it("falls back to the next port when the first is busy", async () => {
    const first = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [first.port, 0] });
    expect(server.port).not.toBe(first.port);
    await first.close();
  });

  it("throws when no port is free", async () => {
    const first = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    await expect(startLocalServer({ hub: hub(), publisherToken: "T", ports: [first.port] })).rejects.toThrow(
      /No free port/,
    );
    await first.close();
  });

  it("accepts viewers from allowed origins", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    const ws = await open(`ws://127.0.0.1:${server.port}/local/viewer`, {
      Origin: `http://localhost:${server.port}`,
    });
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: "watch", peer: "x", source: "y" }));
    expect(await reply).toEqual({ type: "unavailable" });
    ws.close();
  });

  it("accepts extra origins (dev server)", async () => {
    server = await startLocalServer({
      hub: hub(),
      publisherToken: "T",
      ports: [0],
      extraOrigins: ["http://localhost:5173"],
    });
    const ws = await open(`ws://127.0.0.1:${server.port}/local/viewer`, { Origin: "http://localhost:5173" });
    ws.close();
  });

  it("rejects file:// viewers unless explicitly allowed", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    await expect(open(`ws://127.0.0.1:${server.port}/local/viewer`, { Origin: "file://" })).rejects.toThrow(
      "HTTP 403",
    );
  });

  it("rejects viewers from foreign origins", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    await expect(
      open(`ws://127.0.0.1:${server.port}/local/viewer`, { Origin: "https://evil.example" }),
    ).rejects.toThrow("HTTP 403");
  });

  it("rejects local routes arriving through the tunnel", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    await expect(
      open(`ws://127.0.0.1:${server.port}/local/viewer`, { "cf-connecting-ip": "1.2.3.4" }),
    ).rejects.toThrow("HTTP 404");
  });

  it("requires the publisher token", async () => {
    const h = hub();
    server = await startLocalServer({ hub: h, publisherToken: "T", ports: [0] });
    await expect(open(`ws://127.0.0.1:${server.port}/local/publisher?token=nope`)).rejects.toThrow("HTTP 403");
    const ws = await open(`ws://127.0.0.1:${server.port}/local/publisher?token=T`, { Origin: "file://" });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.hasPublisher).toBe(true);
    ws.close();
  });

  it("accepts /hub through the tunnel and runs the handshake", async () => {
    const h = hub();
    server = await startLocalServer({ hub: h, publisherToken: "T", ports: [0] });
    const ws = await open(`ws://127.0.0.1:${server.port}/hub`, { "cf-connecting-ip": "1.2.3.4" });
    const welcome = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", secret: "S", peerName: "Bo", protocolVersion: 1 }));
    expect(await welcome).toMatchObject({ type: "welcome", peerName: "Ana" });
    ws.close();
  });

  it("404s plain HTTP through the tunnel unless a route allows it", async () => {
    server = await startLocalServer({
      hub: hub(),
      publisherToken: "T",
      ports: [0],
      httpRoutes: [
        (_req, res, ctx) => {
          if (ctx.path !== "/join" && ctx.path !== "/hello") return false;
          res.writeHead(200).end("ok");
          return true;
        },
      ],
    });
    const base = `http://127.0.0.1:${server.port}`;
    const tunnel = { "cf-connecting-ip": "1.2.3.4" };
    expect((await fetch(`${base}/hello`)).status).toBe(200);
    expect((await fetch(`${base}/hello`, { headers: tunnel })).status).toBe(404);
    expect((await fetch(`${base}/join`, { headers: tunnel })).status).toBe(200);
    expect((await fetch(`${base}/missing`)).status).toBe(404);
  });

  it("responds 400 instead of crashing on a malformed request target", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    const response = await rawRequest(server.port, "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(response).toMatch(/^HTTP\/1\.1 400/);
  });

  it("refuses the socket with 400 instead of crashing on a malformed upgrade target", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0] });
    const response = await rawRequest(
      server.port,
      "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    expect(response).toMatch(/^HTTP\/1\.1 400/);
  });

  it("responds 500 when a route throws, and keeps serving later requests", async () => {
    server = await startLocalServer({
      hub: hub(),
      publisherToken: "T",
      ports: [0],
      httpRoutes: [
        (_req, _res, ctx) => {
          if (ctx.path === "/boom") throw new Error("boom");
          return false;
        },
      ],
    });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/boom`)).status).toBe(500);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it("treats a reserved/excluded port as busy and tries the next one", async (ctx) => {
    const code = await probeBindErrorCode(5357);
    ctx.skip(code !== "EACCES", "port 5357 does not yield EACCES on this machine");
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [5357, 0] });
    expect(server.port).not.toBe(5357);
  });
});
