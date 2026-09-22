import { describe, expect, it } from "vitest";
import { Hub } from "../../../src/main/hub/hub";
import { FakeChannel, connectHubs, flush, source } from "./fakes";

const ice = [{ urls: "stun:stun.cloudflare.com:3478" }];
const sdpOffer = { kind: "sdp", type: "offer", sdp: "v=0 offer" };
const sdpAnswer = { kind: "sdp", type: "answer", sdp: "v=0 answer" };

async function pair() {
  const host = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => ice });
  const joiner = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => ice });
  const hostPub = new FakeChannel();
  const hostPubIn = host.attachPublisher(hostPub);
  host.setLocalSources([source()]);
  const link = connectHubs(host, joiner, "S");
  await flush();
  return { host, joiner, hostPub, hostPubIn, link };
}

describe("Hub routing: joiner's viewer watches host's source", () => {
  it("routes subscribe and signals end to end", async () => {
    const { joiner, hostPub, hostPubIn } = await pair();
    const viewer = new FakeChannel();
    const viewerIn = joiner.attachViewer(viewer);

    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    const watching = viewer.last("watching")!;
    expect(watching).toMatchObject({ source: { id: "src-game" }, iceServers: ice });
    const subId = watching.subId as string;
    await flush();

    expect(hostPub.last("subscribe")).toEqual({ type: "subscribe", subId, sourceId: "src-game", iceServers: ice });

    hostPubIn.onMessage(JSON.stringify({ type: "signal", subId, payload: sdpOffer }));
    await flush();
    expect(viewer.last("signal")).toEqual({ type: "signal", subId, payload: sdpOffer });

    viewerIn.onMessage(JSON.stringify({ type: "signal", subId, payload: sdpAnswer }));
    await flush();
    expect(hostPub.last("signal")).toEqual({ type: "signal", subId, payload: sdpAnswer });
  });

  it("closing the viewer unsubscribes on the publisher", async () => {
    const { joiner, hostPub } = await pair();
    const viewer = new FakeChannel();
    const viewerIn = joiner.attachViewer(viewer);
    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    const subId = viewer.last("watching")!.subId;
    await flush();
    viewerIn.onClose();
    await flush();
    expect(hostPub.last("unsubscribe")).toEqual({ type: "unsubscribe", subId });
  });

  it("publisher unsubscribe ends the remote viewer", async () => {
    const { joiner, hostPubIn } = await pair();
    const viewer = new FakeChannel();
    joiner.attachViewer(viewer).onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    const subId = viewer.last("watching")!.subId;
    await flush();
    hostPubIn.onMessage(JSON.stringify({ type: "unsubscribe", subId }));
    await flush();
    expect(viewer.last("ended")).toEqual({ type: "ended", subId });
  });

  it("source going unavailable ends the remote viewer", async () => {
    const { host, joiner, hostPubIn } = await pair();
    const viewer = new FakeChannel();
    joiner.attachViewer(viewer).onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    await flush();
    hostPubIn.onMessage(JSON.stringify({ type: "source-status", sourceId: "src-game", status: "unavailable" }));
    await flush();
    expect(host.sources[0]!.status).toBe("unavailable");
    expect(viewer.ofType("ended")).toHaveLength(1);
  });

  it("partner disconnect ends the viewer", async () => {
    const { joiner, link } = await pair();
    const viewer = new FakeChannel();
    joiner.attachViewer(viewer).onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    await flush();
    link.close();
    await flush();
    expect(viewer.ofType("ended")).toHaveLength(1);
  });

  it("replies unavailable for unknown peer, unknown source, or unwatchable source", async () => {
    const { host, joiner, hostPubIn } = await pair();
    const viewer = new FakeChannel();
    const viewerIn = joiner.attachViewer(viewer);
    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "nobody", source: "game" }));
    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "nope" }));
    hostPubIn.onMessage(JSON.stringify({ type: "source-status", sourceId: "src-game", status: "waiting" }));
    await flush();
    expect(host.sources[0]!.status).toBe("waiting");
    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    expect(viewer.ofType("unavailable")).toHaveLength(3);
  });

  it("host without a publisher rejects the partner's subscribe", async () => {
    const host = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => ice });
    const joiner = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => ice });
    host.setLocalSources([source()]);
    connectHubs(host, joiner, "S");
    await flush();
    const viewer = new FakeChannel();
    joiner.attachViewer(viewer).onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    await flush();
    expect(viewer.ofType("ended")).toHaveLength(1);
  });

  it("reports ice-failed from a viewer", async () => {
    const { joiner } = await pair();
    const failures: unknown[] = [];
    joiner.on("p2p-failed", (f: unknown) => failures.push(f));
    const viewer = new FakeChannel();
    const viewerIn = joiner.attachViewer(viewer);
    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    const subId = viewer.last("watching")!.subId;
    viewerIn.onMessage(JSON.stringify({ type: "ice-failed", subId }));
    expect(failures).toEqual([{ subId, sourceId: "src-game" }]);
  });
});

describe("Hub routing: local preview of own source", () => {
  it("routes 'me' watches to the local publisher only", async () => {
    const hub = new Hub({ displayName: "Ana", getInviteSecret: () => null, getIceServers: () => ice });
    const pub = new FakeChannel();
    const pubIn = hub.attachPublisher(pub);
    hub.setLocalSources([source()]);
    const viewer = new FakeChannel();
    const viewerIn = hub.attachViewer(viewer);

    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "me", source: "game" }));
    const subId = viewer.last("watching")!.subId as string;
    expect(pub.last("subscribe")).toEqual({ type: "subscribe", subId, sourceId: "src-game", iceServers: ice });

    pubIn.onMessage(JSON.stringify({ type: "signal", subId, payload: sdpOffer }));
    expect(viewer.last("signal")).toEqual({ type: "signal", subId, payload: sdpOffer });

    viewerIn.onMessage(JSON.stringify({ type: "signal", subId, payload: sdpAnswer }));
    expect(pub.last("signal")).toEqual({ type: "signal", subId, payload: sdpAnswer });
  });

  it("publisher disconnect ends local previews", () => {
    const hub = new Hub({ displayName: "Ana", getInviteSecret: () => null, getIceServers: () => ice });
    const pubIn = hub.attachPublisher(new FakeChannel());
    hub.setLocalSources([source()]);
    const viewer = new FakeChannel();
    hub.attachViewer(viewer).onMessage(JSON.stringify({ type: "watch", peer: "me", source: "game" }));
    pubIn.onClose();
    expect(viewer.ofType("ended")).toHaveLength(1);
  });

  it("marks local sources unavailable when the Publisher disconnects, until it reports again", async () => {
    const { host, joiner, hostPubIn } = await pair();
    hostPubIn.onMessage(JSON.stringify({ type: "source-status", sourceId: "src-game", status: "live" }));
    await flush();
    expect(joiner.partner?.sources[0]?.status).toBe("live");

    hostPubIn.onClose();
    await flush();
    expect(host.sources[0]?.status).toBe("unavailable");
    expect(joiner.partner?.sources[0]?.status).toBe("unavailable");

    const again = host.attachPublisher(new FakeChannel());
    again.onMessage(JSON.stringify({ type: "source-status", sourceId: "src-game", status: "idle" }));
    await flush();
    expect(joiner.partner?.sources[0]?.status).toBe("idle");
  });

  it("a replaced Publisher does not mark sources unavailable", async () => {
    const { host, hostPubIn } = await pair();
    hostPubIn.onMessage(JSON.stringify({ type: "source-status", sourceId: "src-game", status: "live" }));
    host.attachPublisher(new FakeChannel());
    hostPubIn.onClose(); // the old socket closing after replacement
    expect(host.sources[0]?.status).toBe("live");
  });

  it("a viewer cannot inject signals into another viewer's sub", () => {
    const hub = new Hub({ displayName: "Ana", getInviteSecret: () => null, getIceServers: () => ice });
    const pub = new FakeChannel();
    hub.attachPublisher(pub);
    hub.setLocalSources([source()]);
    const a = new FakeChannel();
    hub.attachViewer(a).onMessage(JSON.stringify({ type: "watch", peer: "me", source: "game" }));
    const subId = a.last("watching")!.subId;
    const intruder = hub.attachViewer(new FakeChannel());
    intruder.onMessage(JSON.stringify({ type: "signal", subId, payload: sdpAnswer }));
    expect(pub.ofType("signal")).toHaveLength(0);
  });
});
