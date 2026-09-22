import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../../../src/main/hub/hub";
import { joinPartner, type JoinStatus } from "../../../src/main/hub/joiner";
import { startLocalServer, type LocalServer } from "../../../src/main/hub/local-server";

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

async function host(ports = [0]): Promise<{ hub: Hub; server: LocalServer }> {
  const hub = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
  const server = await startLocalServer({ hub, publisherToken: "T", ports });
  cleanups.push(() => server.close());
  return { hub, server };
}

function joiner(): Hub {
  const hub = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => [] });
  cleanups.push(() => hub.dispose());
  return hub;
}

describe("joinPartner", () => {
  it("connects through an invite link", async () => {
    const h = await host();
    const j = joiner();
    const statuses: JoinStatus[] = [];
    const join = joinPartner({ hub: j, invite: `http://127.0.0.1:${h.server.port}/join#S`, onStatus: (s) => statuses.push(s) });
    cleanups.push(() => join.stop());
    await waitFor(() => j.partner !== null);
    expect(j.partner?.name).toBe("Ana");
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("reports an invalid link without connecting", () => {
    const statuses: [JoinStatus, string | undefined][] = [];
    joinPartner({ hub: joiner(), invite: "garbage", onStatus: (s, d) => statuses.push([s, d]) });
    expect(statuses).toEqual([["failed", "invalid-link"]]);
  });

  it("does not retry after a rejection", async () => {
    const h = await host();
    const statuses: [JoinStatus, string | undefined][] = [];
    const join = joinPartner({
      hub: joiner(),
      invite: `http://127.0.0.1:${h.server.port}/join#WRONG`,
      onStatus: (s, d) => statuses.push([s, d]),
    });
    cleanups.push(() => join.stop());
    await waitFor(() => statuses.some(([s]) => s === "rejected"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(statuses).toEqual([["connecting", undefined], ["rejected", "bad-secret"]]);
  });

  it("reconnects when the host comes back", async () => {
    const first = await host();
    const port = first.server.port;
    const j = joiner();
    const statuses: JoinStatus[] = [];
    const join = joinPartner({ hub: j, invite: `http://127.0.0.1:${port}/join#S`, onStatus: (s) => statuses.push(s) });
    cleanups.push(() => join.stop());
    await waitFor(() => j.partner !== null);
    await first.server.close();
    first.hub.dispose();
    await waitFor(() => statuses.includes("reconnecting"));
    await host([port]);
    await waitFor(() => j.partner !== null);
    expect(statuses.at(-1)).toBe("connected");
  });

  it("fails after the retry window", async () => {
    const h = await host();
    const port = h.server.port;
    await h.server.close();
    const statuses: [JoinStatus, string | undefined][] = [];
    joinPartner({
      hub: joiner(),
      invite: `http://127.0.0.1:${port}/join#S`,
      retryWindowMs: 1500,
      onStatus: (s, d) => statuses.push([s, d]),
    });
    await waitFor(() => statuses.some(([s]) => s === "failed"));
    expect(statuses.at(-1)).toEqual(["failed", "unreachable"]);
  });

  it("stop closes the connection and reports stopped", async () => {
    const h = await host();
    const j = joiner();
    const statuses: JoinStatus[] = [];
    const join = joinPartner({ hub: j, invite: `http://127.0.0.1:${h.server.port}/join#S`, onStatus: (s) => statuses.push(s) });
    await waitFor(() => j.partner !== null);
    join.stop();
    await waitFor(() => h.hub.partner === null);
    expect(statuses.at(-1)).toBe("stopped");
  });
});
