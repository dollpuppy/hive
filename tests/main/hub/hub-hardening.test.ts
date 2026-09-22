import { describe, expect, it, vi } from "vitest";
import { Hub } from "../../../src/main/hub/hub";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol";
import { FakeChannel, connectHubs, flush, source } from "./fakes";

const makeHost = (secret: string | null = "S") =>
  new Hub({ displayName: "Host Ana", getInviteSecret: () => secret, getIceServers: () => [] });
const makeJoiner = (name = "Joiner Bo") =>
  new Hub({ displayName: name, getInviteSecret: () => null, getIceServers: () => [] });

describe("Hub hardening", () => {
  describe("publisher replacement", () => {
    it("ends viewer subs targeting the publisher when a new publisher attaches", () => {
      const host = makeHost();
      host.setLocalSources([source()]);
      const pub1 = new FakeChannel();
      host.attachPublisher(pub1);
      const viewer = new FakeChannel();
      host.attachViewer(viewer).onMessage(JSON.stringify({ type: "watch", peer: "me", source: "game" }));
      expect(viewer.last("watching")).toBeDefined();

      const pub2 = new FakeChannel();
      host.attachPublisher(pub2);

      expect(viewer.last("ended")).toBeDefined();
      expect(pub1.closed).toBe(true);
    });

    it("ignores messages from a replaced publisher", () => {
      const host = makeHost();
      host.setLocalSources([source()]);
      const pub1 = new FakeChannel();
      const handler1 = host.attachPublisher(pub1);
      const pub2 = new FakeChannel();
      host.attachPublisher(pub2);

      handler1.onMessage(JSON.stringify({ type: "source-status", sourceId: "src-game", status: "live" }));

      expect(host.sources[0]?.status).toBe("idle");
    });
  });

  describe("joiner-side handshake", () => {
    it("rejects a second outgoing connection when already partnered, without touching the existing partner", async () => {
      const a = makeHost();
      const b = makeJoiner();
      connectHubs(a, b, "S");
      await flush();
      expect(b.partner?.name).toBe("Host Ana");

      const c = new Hub({ displayName: "C", getInviteSecret: () => "T", getIceServers: () => [] });
      const reasons: string[] = [];
      b.on("rejected", (r: string) => reasons.push(r));
      connectHubs(c, b, "T");
      await flush();

      expect(reasons).toEqual(["full"]);
      expect(b.partner?.name).toBe("Host Ana");
    });
  });

  describe("stale handshake links", () => {
    it("does not let a rejected link's handler re-enter handshake after the slot frees up", () => {
      const host = makeHost("S");
      const p1 = new FakeChannel();
      const h1 = host.attachIncomingPeer(p1);
      h1.onMessage(JSON.stringify({ type: "hello", secret: "S", peerName: "P1", protocolVersion: PROTOCOL_VERSION }));
      expect(host.partner?.name).toBe("P1");

      const p2 = new FakeChannel();
      const h2 = host.attachIncomingPeer(p2);
      h2.onMessage(JSON.stringify({ type: "hello", secret: "S", peerName: "P2", protocolVersion: PROTOCOL_VERSION }));
      expect(p2.last("reject")).toEqual({ type: "reject", reason: "full" });

      h1.onClose();
      expect(host.partner).toBeNull();

      h2.onMessage(
        JSON.stringify({ type: "hello", secret: "S", peerName: "P2 retry", protocolVersion: PROTOCOL_VERSION }),
      );
      expect(host.partner).toBeNull();
    });
  });

  describe("partner unsubscribe scoping", () => {
    it("does not let the partner end a local viewer sub via unsubscribe", () => {
      const host = makeHost("S");
      host.setLocalSources([source()]);
      const pub = new FakeChannel();
      host.attachPublisher(pub);
      const viewer = new FakeChannel();
      host.attachViewer(viewer).onMessage(JSON.stringify({ type: "watch", peer: "me", source: "game" }));
      const watching = viewer.last("watching");
      expect(watching).toBeDefined();
      const subId = watching?.subId as string;

      const peerChannel = new FakeChannel();
      const peerHandler = host.attachIncomingPeer(peerChannel);
      peerHandler.onMessage(
        JSON.stringify({ type: "hello", secret: "S", peerName: "Partner", protocolVersion: PROTOCOL_VERSION }),
      );
      expect(host.partner?.name).toBe("Partner");

      peerHandler.onMessage(JSON.stringify({ type: "unsubscribe", subId }));

      expect(viewer.last("ended")).toBeUndefined();
    });
  });

  describe("handshake timeout", () => {
    it("closes an incoming peer link that never completes the handshake", () => {
      vi.useFakeTimers();
      try {
        const host = makeHost("S");
        const channel = new FakeChannel();
        host.attachIncomingPeer(channel);
        expect(channel.closed).toBe(false);
        vi.advanceTimersByTime(10_000);
        expect(channel.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
