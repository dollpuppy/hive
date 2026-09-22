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

  it("accepts extra origins (dashboard)", async () => {
    server = await startLocalServer({ hub: hub(), publisherToken: "T", ports: [0], extraOrigins: ["file://"] });
    const ws = await open(`ws://127.0.0.1:${server.port}/local/viewer`, { Origin: "file://" });
    ws.close();
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
});
