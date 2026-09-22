import { describe, expect, it } from "vitest";
import { Hub } from "../../../src/main/hub/hub";
import { FakeChannel, connectHubs, flush, source } from "./fakes";

const makeHost = (secret: string | null = "S") =>
  new Hub({ displayName: "Host Ana", getInviteSecret: () => secret, getIceServers: () => [] });
const makeJoiner = () =>
  new Hub({ displayName: "Joiner Bo", getInviteSecret: () => null, getIceServers: () => [] });

describe("Hub handshake", () => {
  it("connects with the right secret and exchanges names", async () => {
    const host = makeHost();
    const joiner = makeJoiner();
    connectHubs(host, joiner, "S");
    await flush();
    expect(host.partner).toEqual({ name: "Joiner Bo", slug: "joiner-bo", sources: [] });
    expect(joiner.partner).toEqual({ name: "Host Ana", slug: "host-ana", sources: [] });
  });

  it("exchanges source lists on connect and on change", async () => {
    const host = makeHost();
    const joiner = makeJoiner();
    host.setLocalSources([source()]);
    connectHubs(host, joiner, "S");
    await flush();
    expect(joiner.partner?.sources).toEqual([source()]);
    joiner.setLocalSources([source({ id: "cam", slug: "cam", name: "Cam", kind: "webcam" })]);
    await flush();
    expect(host.partner?.sources.map((s) => s.slug)).toEqual(["cam"]);
  });

  it("rejects a bad secret", async () => {
    const host = makeHost();
    const joiner = makeJoiner();
    const reasons: string[] = [];
    joiner.on("rejected", (r: string) => reasons.push(r));
    connectHubs(host, joiner, "WRONG");
    await flush();
    expect(reasons).toEqual(["bad-secret"]);
    expect(host.partner).toBeNull();
    expect(joiner.partner).toBeNull();
  });

  it("rejects everyone when not hosting", async () => {
    const host = makeHost(null);
    const joiner = makeJoiner();
    const reasons: string[] = [];
    joiner.on("rejected", (r: string) => reasons.push(r));
    connectHubs(host, joiner, "S");
    await flush();
    expect(reasons).toEqual(["bad-secret"]);
  });

  it("rejects a second partner as full", async () => {
    const host = makeHost();
    connectHubs(host, makeJoiner(), "S");
    await flush();
    const second = makeJoiner();
    const reasons: string[] = [];
    second.on("rejected", (r: string) => reasons.push(r));
    connectHubs(host, second, "S");
    await flush();
    expect(reasons).toEqual(["full"]);
    expect(host.partner?.name).toBe("Joiner Bo");
  });

  it("rejects a protocol version mismatch", () => {
    const host = makeHost();
    const back = new FakeChannel();
    const handler = host.attachIncomingPeer(back);
    handler.onMessage(JSON.stringify({ type: "hello", secret: "S", peerName: "Old", protocolVersion: 0 }));
    expect(back.sent).toEqual([{ type: "reject", reason: "version" }]);
    expect(back.closed).toBe(true);
  });

  it("closes a host-side link whose first message is not hello", () => {
    const host = makeHost();
    const back = new FakeChannel();
    host.attachIncomingPeer(back).onMessage(JSON.stringify({ type: "ping" }));
    expect(back.closed).toBe(true);
  });

  it("never gives a partner the reserved 'me' slug", async () => {
    const host = makeHost();
    const joiner = new Hub({ displayName: "Me", getInviteSecret: () => null, getIceServers: () => [] });
    connectHubs(host, joiner, "S");
    await flush();
    expect(host.partner?.slug).toBe("me-2");
  });

  it("clears the partner when the link closes and emits partner events", async () => {
    const host = makeHost();
    const joiner = makeJoiner();
    const events: (string | null)[] = [];
    host.on("partner", (p: { name: string } | null) => events.push(p ? p.name : null));
    const link = connectHubs(host, joiner, "S");
    await flush();
    link.close();
    await flush();
    expect(host.partner).toBeNull();
    expect(joiner.partner).toBeNull();
    expect(events).toEqual(["Joiner Bo", null]);
  });
});
