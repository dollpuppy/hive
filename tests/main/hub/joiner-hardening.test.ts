import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Hub, type HubOptions } from "../../../src/main/hub/hub";
import { joinPartner, type JoinStatus } from "../../../src/main/hub/joiner";
import { startLocalServer, type LocalServer } from "../../../src/main/hub/local-server";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol";
import { FakeChannel } from "./fakes";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  if (data.length >= 126) throw new Error("test helper only supports short frames");
  return Buffer.concat([Buffer.from([0x81, data.length]), data]);
}

/**
 * A bare TCP "WebSocket" server that completes the opening handshake, sends one frame, and
 * then genuinely stops reading — unlike a real `ws` server (or client), it never acknowledges
 * pings or the closing handshake. This is what a truly half-open host looks like: the `ws`
 * library itself is well-behaved even when the application above it goes silent, so a
 * WebSocketServer that just ignores app messages still completes close handshakes for free.
 */
function startSilentServer(welcome: object): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        const key = /Sec-WebSocket-Key:\s*(.+)/i.exec(chunk.toString("utf8"))?.[1]?.trim() ?? "";
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.write(encodeTextFrame(JSON.stringify(welcome)));
        socket.pause(); // never read again: no pong, no close ack — truly half-open.
      });
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function host(overrides: Partial<HubOptions> = {}, ports = [0]): Promise<{ hub: Hub; server: LocalServer }> {
  const hub = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [], ...overrides });
  const server = await startLocalServer({ hub, publisherToken: "T", ports });
  cleanups.push(() => server.close());
  return { hub, server };
}

function joiner(overrides: Partial<HubOptions> = {}): Hub {
  const hub = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => [], ...overrides });
  cleanups.push(() => hub.dispose());
  return hub;
}

describe("joinPartner hardening", () => {
  it("retries through a host that's still holding our stale link, instead of giving up", async () => {
    const first = await host();
    const port = first.server.port;
    const j = joiner();
    const statuses: JoinStatus[] = [];
    const join = joinPartner({ hub: j, invite: `http://127.0.0.1:${port}/join#S`, onStatus: (s) => statuses.push(s) });
    cleanups.push(() => join.stop());
    await waitFor(() => j.partner !== null);

    // Break the real link, then bring a fresh host up on the same port with its peer slot
    // already occupied by a stale fake link — simulating the old host not having noticed our
    // side dropped yet. The joiner's retry should hit "full" and keep retrying rather than
    // giving up.
    await first.server.close();
    first.hub.dispose();

    const second = await host({}, [port]);
    const stale = new FakeChannel();
    const staleHandler = second.hub.attachIncomingPeer(stale);
    staleHandler.onMessage(
      JSON.stringify({ type: "hello", secret: "S", peerName: "Stale", protocolVersion: PROTOCOL_VERSION }),
    );
    expect(second.hub.partner?.name).toBe("Stale");

    // The joiner's first retry lands ~1s after the disconnect; give it time to hit "full",
    // then free the slot well before the ~2s-later second retry.
    await new Promise((r) => setTimeout(r, 1500));
    staleHandler.onClose();
    expect(second.hub.partner).toBeNull();

    await waitFor(() => j.partner !== null);
    expect(statuses.at(-1)).toBe("connected");
    expect(statuses).not.toContain("rejected");
  });

  it("terminates a silent host quickly instead of waiting on ws's own close timeout", async () => {
    const silent = await startSilentServer({ type: "welcome", peerName: "Silent", protocolVersion: PROTOCOL_VERSION });
    cleanups.push(() => silent.close());
    const port = silent.port;

    const j = joiner({ heartbeatMs: 100, timeoutMs: 300 });
    const statuses: JoinStatus[] = [];
    const join = joinPartner({ hub: j, invite: `http://127.0.0.1:${port}/join#S`, onStatus: (s) => statuses.push(s) });
    cleanups.push(() => join.stop());

    await waitFor(() => j.partner !== null);
    const connectedAt = Date.now();
    await waitFor(() => statuses.includes("reconnecting"));
    expect(Date.now() - connectedAt).toBeLessThan(3000);
  });

  it("gives up an attempt that never gets a welcome, and eventually fails", async () => {
    const wss = new WebSocketServer({ port: 0 });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    const port = (wss.address() as AddressInfo).port;

    const statuses: [JoinStatus, string | undefined][] = [];
    const join = joinPartner({
      hub: joiner(),
      invite: `http://127.0.0.1:${port}/join#S`,
      welcomeTimeoutMs: 300,
      retryWindowMs: 1000,
      onStatus: (s, d) => statuses.push([s, d]),
    });
    cleanups.push(() => join.stop());

    await waitFor(() => statuses.some(([s]) => s === "failed"));
    expect(statuses.at(-1)).toEqual(["failed", "unreachable"]);
  });

  it("refuses to start a second join when the hub already has a partner", async () => {
    const h = await host();
    const j = joiner();
    const first = joinPartner({ hub: j, invite: `http://127.0.0.1:${h.server.port}/join#S`, onStatus: () => undefined });
    cleanups.push(() => first.stop());
    await waitFor(() => j.partner !== null);

    const statuses: [JoinStatus, string | undefined][] = [];
    joinPartner({ hub: j, invite: `http://127.0.0.1:${h.server.port}/join#S`, onStatus: (s, d) => statuses.push([s, d]) });
    expect(statuses).toEqual([["failed", "already-partnered"]]);
  });
});
