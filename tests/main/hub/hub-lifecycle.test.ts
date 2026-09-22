import { afterEach, describe, expect, it, vi } from "vitest";
import { Hub } from "../../../src/main/hub/hub";
import { FakeChannel, connectHubs, flush } from "./fakes";

afterEach(() => {
  vi.useRealTimers();
});

describe("Hub kick", () => {
  it("kick disconnects both sides and the kicked side learns why", async () => {
    const host = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
    const joiner = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => [] });
    const kicked: string[] = [];
    joiner.on("kicked", (r: string) => kicked.push(r));
    connectHubs(host, joiner, "S");
    await flush();
    host.kick("bye");
    await flush();
    expect(host.partner).toBeNull();
    expect(joiner.partner).toBeNull();
    expect(kicked).toEqual(["bye"]);
  });
});

describe("Hub heartbeat", () => {
  it("pings every 10s and drops a silent partner after 30s", () => {
    vi.useFakeTimers();
    const host = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
    const toJoiner = new FakeChannel();
    const hostIn = host.attachIncomingPeer(toJoiner);
    hostIn.onMessage(JSON.stringify({ type: "hello", secret: "S", peerName: "Bo", protocolVersion: 1 }));
    expect(host.partner?.name).toBe("Bo");

    vi.advanceTimersByTime(10_000);
    expect(toJoiner.ofType("ping")).toHaveLength(1);

    vi.advanceTimersByTime(20_000);
    expect(host.partner?.name).toBe("Bo");
    vi.advanceTimersByTime(10_000);
    expect(host.partner).toBeNull();
    expect(toJoiner.closed).toBe(true);
  });

  it("any message from the partner keeps the link alive", () => {
    vi.useFakeTimers();
    const host = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
    const hostIn = host.attachIncomingPeer(new FakeChannel());
    hostIn.onMessage(JSON.stringify({ type: "hello", secret: "S", peerName: "Bo", protocolVersion: 1 }));
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      hostIn.onMessage(JSON.stringify({ type: "pong" }));
    }
    expect(host.partner?.name).toBe("Bo");
  });

  it("answers ping with pong", () => {
    const host = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
    const back = new FakeChannel();
    const hostIn = host.attachIncomingPeer(back);
    hostIn.onMessage(JSON.stringify({ type: "hello", secret: "S", peerName: "Bo", protocolVersion: 1 }));
    hostIn.onMessage(JSON.stringify({ type: "ping" }));
    expect(back.ofType("pong")).toHaveLength(1);
    host.dispose();
  });
});
