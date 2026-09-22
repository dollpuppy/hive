import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Hub } from "../../src/main/hub/hub";
import { joinPartner } from "../../src/main/hub/joiner";
import { startLocalServer } from "../../src/main/hub/local-server";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function collect(ws: WebSocket): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  ws.on("message", (d) => out.push(JSON.parse(d.toString())));
  return out;
}

async function until(pred: () => boolean): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 8000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("two hubs over real sockets", () => {
  it("relays subscribe and SDP between publisher and remote viewer", async () => {
    const hostHub = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
    const joinHub = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => [] });
    const hostServer = await startLocalServer({ hub: hostHub, publisherToken: "HT", ports: [0] });
    const joinServer = await startLocalServer({ hub: joinHub, publisherToken: "JT", ports: [0] });
    cleanups.push(() => hostServer.close(), () => joinServer.close(), () => joinHub.dispose(), () => hostHub.dispose());

    const pub = await open(`ws://127.0.0.1:${hostServer.port}/local/publisher?token=HT`);
    cleanups.push(() => pub.close());
    const pubMsgs = collect(pub);
    hostHub.setLocalSources([
      { id: "g", name: "Game", slug: "game", kind: "window", alpha: false, width: 1280, height: 720, fps: 30, status: "idle" },
    ]);

    const join = joinPartner({
      hub: joinHub,
      invite: `http://127.0.0.1:${hostServer.port}/join#S`,
      onStatus: () => undefined,
    });
    cleanups.push(() => join.stop());
    await until(() => (joinHub.partner?.sources.length ?? 0) === 1);

    const viewer = await open(`ws://127.0.0.1:${joinServer.port}/local/viewer`);
    cleanups.push(() => viewer.close());
    const viewerMsgs = collect(viewer);
    viewer.send(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));

    await until(() => pubMsgs.some((m) => m.type === "subscribe"));
    const subId = viewerMsgs.find((m) => m.type === "watching")!.subId as string;
    expect(pubMsgs.find((m) => m.type === "subscribe")).toMatchObject({ subId, sourceId: "g" });

    pub.send(JSON.stringify({ type: "signal", subId, payload: { kind: "sdp", type: "offer", sdp: "OFFER" } }));
    await until(() => viewerMsgs.some((m) => m.type === "signal"));
    viewer.send(JSON.stringify({ type: "signal", subId, payload: { kind: "sdp", type: "answer", sdp: "ANSWER" } }));
    await until(() => pubMsgs.some((m) => m.type === "signal"));
    expect(pubMsgs.find((m) => m.type === "signal")).toMatchObject({ payload: { sdp: "ANSWER" } });

    viewer.close();
    await until(() => pubMsgs.some((m) => m.type === "unsubscribe"));
  });
});
