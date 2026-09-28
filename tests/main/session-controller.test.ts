import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type HiveConfig, type SourceConfig } from "../../src/main/config/config-store";
import { Hub, type Partner } from "../../src/main/hub/hub";
import type { JoinHandle, JoinOptions } from "../../src/main/hub/joiner";
import { SessionController } from "../../src/main/session/session-controller";
import type { SpoutOutputKey } from "../../src/main/spout/spout-output-plan";
import type { TunnelState } from "../../src/main/tunnel/tunnel-manager";
import type { DashboardState } from "../../src/shared/dashboard-api";
import { DEFAULT_ICE_SERVERS } from "../../src/shared/source-info";

class FakeTunnel extends EventEmitter {
  state: TunnelState = { status: "stopped" };
  started: number[] = [];
  start(port: number): void {
    this.started.push(port);
    this.set({ status: "starting" });
  }
  stop(): void {
    this.set({ status: "stopped" });
  }
  set(s: TunnelState): void {
    this.state = s;
    this.emit("state", s);
  }
}

let saved: HiveConfig[];
let published: SourceConfig[][];
let synced: [Partner | null, SpoutOutputKey[]][];
let joins: { opts: JoinOptions; stopped: boolean }[];
let tunnel: FakeTunnel;
let hub: Hub;
let session: SessionController;
let ids: number;

function make(
  config: Partial<HiveConfig> = {},
  port = 7420,
  spoutGraceMs?: number,
  saveConfigImpl?: (c: HiveConfig) => Promise<void>,
): void {
  saved = [];
  published = [];
  synced = [];
  joins = [];
  ids = 0;
  tunnel = new FakeTunnel();
  hub = new Hub({ displayName: "Ana", getInviteSecret: () => session.inviteSecret, getIceServers: () => session.iceServers });
  session = new SessionController({
    config: { ...defaultConfig(), displayName: "Ana", ...config },
    saveConfig:
      saveConfigImpl ??
      (async (c) => {
        saved.push(c);
      }),
    hub,
    port,
    tunnel,
    join: (opts: JoinOptions): JoinHandle => {
      const entry = { opts, stopped: false };
      joins.push(entry);
      return {
        stop: () => {
          entry.stopped = true;
          opts.onStatus("stopped");
        },
      };
    },
    notifyPublisherSources: (s) => published.push(s),
    syncSpoutOutputs: (p, keys) => synced.push([p, keys]),
    newId: () => `id${++ids}`,
    ...(spoutGraceMs !== undefined ? { spoutGraceMs } : {}),
  });
}

const last = (): DashboardState => session.state();

beforeEach(() => make());

describe("server", () => {
  it("starts the tunnel and exposes the invite link once up", () => {
    session.startServer();
    expect(tunnel.started).toEqual([7420]);
    expect(last().server).toEqual({ status: "starting", inviteLink: null });
    tunnel.set({ status: "up", url: "https://a.trycloudflare.com" });
    expect(last().server).toEqual({
      status: "up",
      inviteLink: `https://a.trycloudflare.com/join#${session.inviteSecret}`,
    });
  });

  it("rotates the secret each start and clears it on stop", () => {
    session.startServer();
    const first = session.inviteSecret;
    session.stopServer();
    expect(session.inviteSecret).toBeNull();
    session.startServer();
    expect(session.inviteSecret).not.toBe(first);
  });

  it("uses the stored secret when keepSecret is on", () => {
    make({ keepSecret: true, secret: "stable" });
    session.startServer();
    expect(session.inviteSecret).toBe("stable");
  });

  it("warns when the tunnel url changes", () => {
    session.startServer();
    tunnel.set({ status: "up", url: "https://a.trycloudflare.com" });
    tunnel.set({ status: "restarting", attempt: 1 });
    tunnel.set({ status: "up", url: "https://b.trycloudflare.com" });
    expect(last().banners.map((b) => b.id)).toContain("invite-changed");
  });

  it("shows a banner when the tunnel fails and clears it on retry", () => {
    session.startServer();
    tunnel.set({ status: "failed", error: "cloudflared exited 4 times" });
    expect(last().banners.map((b) => b.id)).toContain("tunnel-failed");
    session.startServer();
    expect(last().banners.map((b) => b.id)).not.toContain("tunnel-failed");
    expect(tunnel.started).toHaveLength(2);
  });

  it("flags a fallback port", () => {
    make({}, 7421);
    expect(last().banners.map((b) => b.id)).toContain("port-fallback");
  });

  it("clears a stray secret at startup when keepSecret is off (amendment 6)", () => {
    make({ keepSecret: false, secret: "leftover" });
    expect(saved.at(-1)!.secret).toBeNull();
    expect(session.config.secret).toBeNull();
  });

  it("does not touch a stored secret at startup when keepSecret is on", () => {
    make({ keepSecret: true, secret: "stable" });
    expect(saved).toEqual([]);
  });
});

describe("sources", () => {
  it("adds a source with id and unique slug, persists, updates hub and publisher", async () => {
    await session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "melonDS" });
    await session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "other" });
    expect(last().sources.map((s) => [s.id, s.slug, s.status])).toEqual([
      ["id1", "game", "idle"],
      ["id2", "game-2", "idle"],
    ]);
    expect(saved.at(-1)!.sources).toHaveLength(2);
    expect(hub.sources.map((s) => s.slug)).toEqual(["game", "game-2"]);
    expect(published.at(-1)).toHaveLength(2);
  });

  it("rejects invalid input with a readable message", async () => {
    await expect(
      session.addSource({ kind: "url", name: "T", preset: "low", url: "file:///c:/x", width: 800, height: 600 }),
    ).rejects.toThrow("URL must start with http:// or https://");
    await expect(
      session.addSource({ kind: "url", name: "T", preset: "low", url: "http://x/", width: 0, height: 600 }),
    ).rejects.toThrow(/Invalid source: width/);
  });

  it("updates keeping the id, recomputing the slug; refuses kind changes", async () => {
    await session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "A" });
    await session.updateSource("id1", { kind: "window", name: "Main Game", preset: "high", windowTitle: "B" });
    expect(last().sources[0]).toMatchObject({ id: "id1", slug: "main-game", preset: "high", windowTitle: "B" });
    await expect(
      session.updateSource("id1", { kind: "spout", name: "X", preset: "low", senderName: "S" }),
    ).rejects.toThrow("type can't be changed");
  });

  it("removes a source", async () => {
    await session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "A" });
    await session.removeSource("id1");
    expect(last().sources).toEqual([]);
    expect(hub.sources).toEqual([]);
  });

  it("retrySource re-sends the current sources to the publisher (amendment 1)", async () => {
    await session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "A" });
    published.length = 0;
    await session.retrySource("id1");
    expect(published.at(-1)).toHaveLength(1);
  });

  it("retrySource throws for an unknown id (amendment 1)", async () => {
    await expect(session.retrySource("nope")).rejects.toThrow("Source not found.");
  });
});

describe("joining", () => {
  it("tracks join status and leave", () => {
    session.join("https://a.trycloudflare.com/join#S");
    expect(last().join.status).toBe("connecting");
    joins[0]!.opts.onStatus("connected");
    expect(last().join.status).toBe("connected");
    session.leave();
    expect(joins[0]!.stopped).toBe(true);
    expect(last().join).toEqual({ status: "idle", detail: null });
  });

  it("joining again stops the previous attempt", () => {
    session.join("https://a.trycloudflare.com/join#S");
    session.join("https://b.trycloudflare.com/join#T");
    expect(joins[0]!.stopped).toBe(true);
    expect(joins).toHaveLength(2);
  });

  it("keeps terminal statuses with detail", () => {
    session.join("x");
    joins[0]!.opts.onStatus("rejected", "bad-secret");
    expect(last().join).toEqual({ status: "rejected", detail: "bad-secret" });
  });

  it("does not emit state for a duplicate join status (amendment 2)", () => {
    session.join("https://a.trycloudflare.com/join#S");
    const states: DashboardState[] = [];
    session.on("state", (s: DashboardState) => states.push(s));
    joins[0]!.opts.onStatus("connecting");
    expect(states).toHaveLength(0);
    joins[0]!.opts.onStatus("connected");
    expect(states).toHaveLength(1);
  });
});

describe("spout out and settings", () => {
  it("toggles spout outputs and syncs", async () => {
    await session.setSpoutOut("bo", "vtuber", true);
    expect(last().spoutOut).toEqual([{ partnerSlug: "bo", sourceSlug: "vtuber" }]);
    expect(synced.at(-1)).toEqual([null, [{ partnerSlug: "bo", sourceSlug: "vtuber" }]]);
    await session.setSpoutOut("bo", "vtuber", false);
    expect(last().spoutOut).toEqual([]);
  });

  it("a failing spout output turns itself off with a banner", async () => {
    await session.setSpoutOut("bo", "vtuber", true);
    session.reportSpoutOutputError("bo/vtuber", new Error("name collision"));
    await new Promise((r) => setTimeout(r, 0));
    expect(last().spoutOut).toEqual([]);
    expect(last().banners.map((b) => b.id)).toContain("spout-output-failed");
  });

  it("records the error per key and clears it when the toggle is turned back on (amendment 5)", async () => {
    await session.setSpoutOut("bo", "vtuber", true);
    session.reportSpoutOutputError("bo/vtuber", new Error("name collision"));
    await new Promise((r) => setTimeout(r, 0));
    expect(last().spoutOutErrors).toEqual({ "bo/vtuber": "name collision" });
    await session.setSpoutOut("bo", "vtuber", true);
    expect(last().spoutOutErrors).toEqual({});
  });

  it("updates settings: name, TURN, keepSecret", async () => {
    await session.updateSettings({
      displayName: " Ana B ",
      turn: { url: "turn:t.example:3478", username: "u", credential: "p" },
      keepSecret: true,
    });
    expect(last().displayName).toBe("Ana B");
    expect(session.iceServers).toEqual([
      ...DEFAULT_ICE_SERVERS,
      { urls: "turn:t.example:3478", username: "u", credential: "p" },
    ]);
    expect(saved.at(-1)!.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(session.updateSettings({ displayName: "", turn: null, keepSecret: false })).rejects.toThrow(
      "Display name",
    );
    await expect(
      session.updateSettings({ displayName: "A", turn: { url: "http://x", username: "", credential: "" }, keepSecret: false }),
    ).rejects.toThrow("TURN URL");
  });
});

describe("banners from the hub", () => {
  it("shows and clears upload-struggling; shows p2p-failed; dismiss", () => {
    hub.emit("health", true);
    expect(last().banners.map((b) => b.id)).toContain("upload-struggling");
    hub.emit("health", false);
    expect(last().banners.map((b) => b.id)).not.toContain("upload-struggling");
    hub.emit("p2p-failed", { subId: "x", sourceId: "y" });
    expect(last().banners.map((b) => b.id)).toContain("p2p-failed");
    session.dismissBanner("p2p-failed");
    expect(last().banners).toEqual([]);
  });

  it("shows publisher-down when the publisher disconnects, clears it on reconnect (amendment 3)", () => {
    hub.emit("publisher", false);
    expect(last().banners.map((b) => b.id)).toContain("publisher-down");
    hub.emit("publisher", true);
    expect(last().banners.map((b) => b.id)).not.toContain("publisher-down");
  });

  it("emits state on every change", async () => {
    const states: DashboardState[] = [];
    session.on("state", (s: DashboardState) => states.push(s));
    session.startServer();
    await session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "A" });
    expect(states.length).toBeGreaterThanOrEqual(2);
  });
});

describe("spout output grace period (amendment 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    make();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const bo: Partner = { name: "Bo", slug: "bo", sources: [] };

  it("does not sync immediately on a plain disconnect, then syncs null after the grace period", () => {
    hub.emit("partner", bo);
    synced.length = 0;
    hub.emit("partner", null);
    expect(synced).toEqual([]);
    vi.advanceTimersByTime(59_999);
    expect(synced).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(synced).toEqual([[null, []]]);
  });

  it("cancels the grace timer and syncs immediately when the partner reconnects", () => {
    hub.emit("partner", bo);
    synced.length = 0;
    hub.emit("partner", null);
    vi.advanceTimersByTime(1_000);
    hub.emit("partner", bo);
    expect(synced.at(-1)).toEqual([bo, []]);
    vi.advanceTimersByTime(60_000);
    expect(synced).toHaveLength(1);
  });

  it("syncs immediately (no grace) when the disconnect follows a kick of the partner", () => {
    hub.emit("partner", bo);
    synced.length = 0;
    hub.emit("kicked-partner");
    hub.emit("partner", null);
    expect(synced).toEqual([[null, []]]);
    vi.advanceTimersByTime(60_000);
    expect(synced).toHaveLength(1);
  });

  it("syncs immediately (no grace) when we were kicked", () => {
    hub.emit("partner", bo);
    synced.length = 0;
    hub.emit("kicked", "removed by partner");
    hub.emit("partner", null);
    expect(synced).toEqual([[null, []]]);
  });

  it("syncs immediately (no grace) when we called leave()", () => {
    session.join("https://a.trycloudflare.com/join#S");
    joins[0]!.opts.onStatus("connected");
    hub.emit("partner", bo);
    synced.length = 0;
    session.leave();
    hub.emit("partner", null);
    expect(synced).toEqual([[null, []]]);
  });

  it("dispose() clears a pending grace timer", () => {
    hub.emit("partner", bo);
    synced.length = 0;
    hub.emit("partner", null);
    session.dispose();
    vi.advanceTimersByTime(60_000);
    expect(synced).toEqual([]);
  });

  it("a partner drop after dispose() (hub.dispose() at shutdown) arms no grace timer", () => {
    hub.emit("partner", bo);
    synced.length = 0;
    session.dispose();
    hub.emit("partner", null);
    vi.advanceTimersByTime(60_000);
    expect(synced).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leave() with no live partner flushes immediately and does not leave the flag stuck (fix round 1, issue 1, scenario A)", () => {
    session.join("https://a.trycloudflare.com/join#S");
    synced.length = 0;
    session.leave();
    expect(synced).toEqual([[null, []]]);
    // A later, unrelated genuine connect+drop must still get the full grace period — if leave()
    // had left kickOrLeavePending stuck, this would sync immediately instead of waiting 60s.
    synced.length = 0;
    hub.emit("partner", bo);
    synced.length = 0;
    hub.emit("partner", null);
    expect(synced).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(synced).toEqual([[null, []]]);
  });

  it("leave() during an active grace window flushes immediately instead of waiting out the timer (fix round 1, issue 1, scenario B)", () => {
    hub.emit("partner", bo);
    synced.length = 0;
    hub.emit("partner", null);
    vi.advanceTimersByTime(1_000);
    expect(synced).toEqual([]);
    session.leave();
    expect(synced).toEqual([[null, []]]);
    vi.advanceTimersByTime(60_000);
    expect(synced).toHaveLength(1);
  });
});

describe("save failures (fix round 1, issue 2)", () => {
  let unhandled: unknown[];
  const onUnhandledRejection = (err: unknown): void => {
    unhandled.push(err);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandledRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
  });

  it("applySources applies its side effects even when the save rejects, and still rejects to the caller", async () => {
    make({}, 7420, undefined, async () => {
      throw new Error("disk full");
    });
    await expect(
      session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "A" }),
    ).rejects.toThrow("disk full");
    // Side effects ran before the save was awaited: source is in state, hub and publisher got it.
    expect(last().sources.map((s) => s.slug)).toEqual(["game"]);
    expect(hub.sources.map((s) => s.slug)).toEqual(["game"]);
    expect(published.at(-1)).toHaveLength(1);
  });

  it("setSpoutOut applies its side effects even when the save rejects, and still rejects to the caller", async () => {
    make({}, 7420, undefined, async () => {
      throw new Error("disk full");
    });
    await expect(session.setSpoutOut("bo", "vtuber", true)).rejects.toThrow("disk full");
    expect(last().spoutOut).toEqual([{ partnerSlug: "bo", sourceSlug: "vtuber" }]);
    expect(synced.at(-1)).toEqual([null, [{ partnerSlug: "bo", sourceSlug: "vtuber" }]]);
  });

  it("updateSettings applies its side effects even when the save rejects, and still rejects to the caller", async () => {
    make({}, 7420, undefined, async () => {
      throw new Error("disk full");
    });
    await expect(
      session.updateSettings({ displayName: "New Name", turn: null, keepSecret: false }),
    ).rejects.toThrow("disk full");
    expect(last().displayName).toBe("New Name");
  });

  it("a rejecting save from startServer's fire-and-forget secret rotation logs and does not throw or go unhandled", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // keepSecret with no stored secret yet: startServer() generates one and persists it in the
    // background (fire-and-forget — there is no caller here to reject to).
    make({ keepSecret: true, secret: null }, 7420, undefined, async () => {
      throw new Error("disk full");
    });
    session.startServer();
    await new Promise((r) => setTimeout(r, 0));
    expect(errorSpy).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    errorSpy.mockRestore();
  });

  it("a rejecting save from reportSpoutOutputError's fire-and-forget revert logs and does not go unhandled", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    make({}, 7420, undefined, async () => {
      throw new Error("disk full");
    });
    await session.setSpoutOut("bo", "vtuber", true).catch(() => undefined);
    session.reportSpoutOutputError("bo/vtuber", new Error("name collision"));
    await new Promise((r) => setTimeout(r, 0));
    expect(last().spoutOut).toEqual([]);
    expect(last().spoutOutErrors).toEqual({ "bo/vtuber": "name collision" });
    expect(errorSpy).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    errorSpy.mockRestore();
  });

  it("a rejecting save from the constructor's stray-secret cleanup logs and does not go unhandled", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    make({ keepSecret: false, secret: "leftover" }, 7420, undefined, async () => {
      throw new Error("disk full");
    });
    expect(session.config.secret).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(errorSpy).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    errorSpy.mockRestore();
  });
});
