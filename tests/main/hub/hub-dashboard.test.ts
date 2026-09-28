import { describe, expect, it } from "vitest";
import { Hub } from "../../../src/main/hub/hub";
import { FakeChannel, connectHubs, flush, source } from "./fakes";

describe("Hub dashboard support", () => {
  it("setDisplayName applies to the next handshake", async () => {
    const host = new Hub({ displayName: "Old", getInviteSecret: () => "S", getIceServers: () => [] });
    host.setDisplayName("New Name");
    const joiner = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => [] });
    connectHubs(host, joiner, "S");
    await flush();
    expect(joiner.partner?.name).toBe("New Name");
  });

  it("counts partner viewers per local source and emits on change", async () => {
    const host = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
    const joiner = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => [] });
    host.attachPublisher(new FakeChannel());
    host.setLocalSources([source()]);
    let events = 0;
    host.on("watchers", () => events++);
    connectHubs(host, joiner, "S");
    await flush();

    const viewer = new FakeChannel();
    const viewerIn = joiner.attachViewer(viewer);
    viewerIn.onMessage(JSON.stringify({ type: "watch", peer: "ana", source: "game" }));
    await flush();
    expect(host.watcherCounts()).toEqual({ "src-game": 1 });

    viewerIn.onClose();
    await flush();
    expect(host.watcherCounts()).toEqual({});
    expect(events).toBe(2);
  });

  it("does not count local previews as watchers", () => {
    const hub = new Hub({ displayName: "Ana", getInviteSecret: () => null, getIceServers: () => [] });
    hub.attachPublisher(new FakeChannel());
    hub.setLocalSources([source()]);
    hub.attachViewer(new FakeChannel()).onMessage(JSON.stringify({ type: "watch", peer: "me", source: "game" }));
    expect(hub.watcherCounts()).toEqual({});
  });
});
