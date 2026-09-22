# Hive Plan 4 — Dashboard, Invite Links & Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the streamer-facing app:
- **Dashboard:** the approved layout, with Start/Stop Server, Copy invite, Join, tabs, source rows with live previews, Copy URL, Spout out toggles, and Add/Edit source.
- **Banners:** for every failure in spec §10.
- **Invite page:** a `/join` landing page reachable through the tunnel.
- **Deep links:** `hive://` deep-link handling.
- **Installer:** a Windows installer with `cloudflared.exe` bundled.

**Architecture:**
- **`SessionController`** (main process, Node-testable) owns everything the dashboard can do. It holds the current config and invite secret, drives the `TunnelManager` and joiner, keeps the Hub and Publisher in sync with source edits, and derives a single serialisable `DashboardState` plus banners.
- **Dashboard window:** a context-isolated, sandboxed renderer. It talks only through a `window.hive` API exposed by its preload.
- **Rendering:** plain TypeScript DOM functions re-render from state. The invite input and dialogs are persistent elements, so re-renders never lose typing.
- **Live previews:** reuse `ViewerClient` (partner sources, plus `me` for your own sources) and pause while the window is hidden.

**Tech Stack:** Plans 1–3 stack, plus electron-builder 26.15.3 (NSIS, `asarUnpack`) and cloudflared 2026.9.1 (pinned, hash-locked on first download).

**Spec:** `docs/superpowers/specs/2026-09-21-hive-design.md` §3.2–3.3 (hosting/joining, connect flow, landing page + deep link), §5 (dashboard UI + palette), §8 (secret rotation, kick), §9 (window bounds, spoutOut), §10 (banners).

**Prerequisite:** Plans 1–3 complete.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/hub/hub.ts` | + `setDisplayName`, `watcherCounts`, `"watchers"` event |
| `src/renderer/publisher/capture-manager.ts` | + restart capture when a source's config changes |
| `src/shared/dashboard-api.ts` | `DashboardState`, `SourceInput`, `DashboardApi` contract |
| `src/main/session/session-controller.ts` | All dashboard actions + derived state + banners |
| `src/main/hub/join-page.ts` | `/join` landing page route |
| `src/main/deep-link.ts` | Parse `hive://join?link=…` from argv |
| `src/main/dashboard-ipc.ts` | `ipcMain.handle` bindings for `DashboardApi` |
| `src/main/dashboard-window.ts` | Dashboard BrowserWindow |
| `src/main/app-core.ts` | Rewritten: full app wiring |
| `src/main/index.ts` | Rewritten: single instance, protocol, startup |
| `src/preload/dashboard.ts` | `contextBridge` → `window.hive` |
| `src/renderer/dashboard/*` | `index.html`, `styles.css`, `dom.ts`, `previews.ts`, `source-dialog.ts`, `settings-dialog.ts`, `main.ts` |
| `scripts/fetch-cloudflared.mjs`, `scripts/cloudflared.lock.json` | Pinned cloudflared download with hash lock |
| `electron-builder.yml` | Windows installer config |
| `tests/**` | Unit tests + dashboard e2e with mocked API |

---

### Task 1: Hub — display name updates and watcher counts

**Files:**
- Modify: `src/main/hub/hub.ts`
- Test: `tests/main/hub/hub-dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/main/hub/hub-dashboard.test.ts`
Expected: FAIL — `host.setDisplayName is not a function`.

- [ ] **Step 3: Modify `src/main/hub/hub.ts`**

1. Add a field below `private heartbeat ...`:

```ts
  private displayName: string;
```

2. Initialise it in the constructor:

```ts
  constructor(private readonly opts: HubOptions) {
    super();
    this.displayName = opts.displayName;
  }
```

3. Replace both uses of `this.opts.displayName` (the `hello` in `attachOutgoingPeer` and the `welcome` in `onHandshake`) with `this.displayName`.

4. Add public methods after `get hasPublisher()`:

```ts
  /** Takes effect on the next handshake; the current partner keeps the old name. */
  setDisplayName(name: string): void {
    this.displayName = name;
  }

  /** Partner viewers per local source id — the dashboard's "N watching". */
  watcherCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const sub of this.subs.values()) {
      if (sub.viewer === null) counts[sub.sourceId] = (counts[sub.sourceId] ?? 0) + 1;
    }
    return counts;
  }
```

5. In `onPartnerSubscribe`, after `this.sendPublisher({ type: "subscribe", ... })` add `this.emit("watchers");`.

6. In `endSub`, after `this.subs.delete(subId);` add:

```ts
    if (sub.viewer === null) this.emit("watchers");
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/main/hub` → all Hub tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/hub/hub.ts tests/main/hub/hub-dashboard.test.ts
git commit -m "feat: Hub display name updates and watcher counts"
```

---

### Task 2: CaptureManager restarts capture when a source's config changes

Editing a source (new window, new preset) must take effect for current viewers. The capture stops and viewers' sessions end. Viewers reconnect on their own backoff and get the new capture.

**Files:**
- Modify: `src/renderer/publisher/capture-manager.ts`
- Test: `tests/web/capture-edit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { SourceConfig } from "../../src/main/config/config-store";
import { CaptureManager } from "../../src/renderer/publisher/capture-manager";

const game: SourceConfig = { id: "g", name: "Game", slug: "game", preset: "med", kind: "window", windowTitle: "A" };

describe("CaptureManager config edits", () => {
  it("restarts an active capture when its config changes", async () => {
    const statuses: string[] = [];
    const ended: string[] = [];
    let stopped = 0;
    const track = { stop: () => stopped++, contentHint: "", addEventListener: () => undefined };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const mgr = new CaptureManager({
      openers: { window: async () => ({ stream }) },
      onStatus: (_id, s) => statuses.push(s),
      onEnded: (id) => ended.push(id),
    });
    mgr.setSources([game]);
    await mgr.acquire("g");
    mgr.setSources([{ ...game, windowTitle: "B" }]);
    expect(stopped).toBe(1);
    expect(ended).toEqual(["g"]);
    expect(statuses.at(-1)).toBe("idle");
  });

  it("leaves an active capture alone when config is unchanged", async () => {
    let stopped = 0;
    const track = { stop: () => stopped++, contentHint: "", addEventListener: () => undefined };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const mgr = new CaptureManager({
      openers: { window: async () => ({ stream }) },
      onStatus: () => undefined,
      onEnded: () => undefined,
    });
    mgr.setSources([game]);
    await mgr.acquire("g");
    mgr.setSources([{ ...game }]);
    expect(stopped).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/web/capture-edit.test.ts` → FAIL (`stopped` is 0).

- [ ] **Step 3: Replace `setSources` in `CaptureManager`**

```ts
  setSources(sources: SourceConfig[]): void {
    const next = new Map(sources.map((s) => [s.id, s]));
    for (const id of [...this.active.keys()]) {
      if (!next.has(id)) this.stop(id);
    }
    for (const s of sources) {
      const prev = this.sources.get(s.id);
      if (!prev) {
        this.opts.onStatus(s.id, "idle");
      } else if (this.active.has(s.id) && JSON.stringify(prev) !== JSON.stringify(s)) {
        this.stop(s.id);
        this.opts.onStatus(s.id, "idle");
        this.opts.onEnded(s.id);
      }
    }
    this.sources = next;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/web` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/publisher/capture-manager.ts tests/web/capture-edit.test.ts
git commit -m "feat: restart capture when a source's config is edited"
```

---

### Task 3: Dashboard API contract

**Files:**
- Create: `src/shared/dashboard-api.ts`

- [ ] **Step 1: Create `src/shared/dashboard-api.ts`**

```ts
import type { Preset, SourceConfig } from "../main/config/config-store";
import type { JoinStatus } from "../main/hub/joiner";
import type { SpoutOutputKey } from "../main/spout/spout-output-plan";
import type { TunnelState } from "../main/tunnel/tunnel-manager";
import type { SourceInfo, SourceStatus } from "./protocol";

export type ServerStatus = TunnelState["status"];

export type BannerId =
  | "invite-changed"
  | "upload-struggling"
  | "p2p-failed"
  | "port-fallback"
  | "tunnel-failed"
  | "spout-output-failed";

export interface Banner {
  id: BannerId;
  message: string;
}

export interface TurnSettings {
  url: string;
  username: string;
  credential: string;
}

export type LocalSource = SourceConfig & { status: SourceStatus };

export interface DashboardState {
  displayName: string;
  port: number;
  server: { status: ServerStatus; inviteLink: string | null };
  join: { status: JoinStatus | "idle"; detail: string | null };
  partner: { name: string; slug: string; sources: SourceInfo[] } | null;
  sources: LocalSource[];
  /** Partner viewers per local source id. */
  watchers: Record<string, number>;
  spoutOut: SpoutOutputKey[];
  banners: Banner[];
  settings: { turn: TurnSettings | null; keepSecret: boolean };
}

export type SourceInput =
  | { kind: "window"; name: string; preset: Preset; windowTitle: string }
  | { kind: "webcam"; name: string; preset: Preset; deviceId: string; deviceLabel: string }
  | { kind: "spout"; name: string; preset: Preset; senderName: string }
  | { kind: "url"; name: string; preset: Preset; url: string; width: number; height: number };

export interface SettingsInput {
  displayName: string;
  turn: TurnSettings | null;
  keepSecret: boolean;
}

export interface CapturableWindow {
  title: string;
  /** data: URL */
  thumbnail: string;
}

export interface DashboardApi {
  getState(): Promise<DashboardState>;
  onState(listener: (state: DashboardState) => void): void;
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
  join(link: string): Promise<void>;
  leave(): Promise<void>;
  kick(): Promise<void>;
  addSource(input: SourceInput): Promise<void>;
  updateSource(id: string, input: SourceInput): Promise<void>;
  removeSource(id: string): Promise<void>;
  setSpoutOut(partnerSlug: string, sourceSlug: string, enabled: boolean): Promise<void>;
  updateSettings(input: SettingsInput): Promise<void>;
  dismissBanner(id: BannerId): Promise<void>;
  listWindows(): Promise<CapturableWindow[]>;
  listSpoutSenders(): Promise<string[]>;
  copy(text: string): Promise<void>;
}

declare global {
  interface Window {
    hive: DashboardApi;
  }
}
```

All imports are `import type`, so the renderer bundle pulls in no main-process code.

- [ ] **Step 2: Typecheck** → `npm run typecheck` exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/shared/dashboard-api.ts
git commit -m "feat: define dashboard API contract"
```

---

### Task 4: SessionController

**Files:**
- Create: `src/main/session/session-controller.ts`
- Test: `tests/main/session-controller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
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

function make(config: Partial<HiveConfig> = {}, port = 7420): void {
  saved = [];
  published = [];
  synced = [];
  joins = [];
  ids = 0;
  tunnel = new FakeTunnel();
  hub = new Hub({ displayName: "Ana", getInviteSecret: () => session.inviteSecret, getIceServers: () => session.iceServers });
  session = new SessionController({
    config: { ...defaultConfig(), displayName: "Ana", ...config },
    saveConfig: async (c) => {
      saved.push(c);
    },
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

  it("emits state on every change", async () => {
    const states: DashboardState[] = [];
    session.on("state", (s: DashboardState) => states.push(s));
    session.startServer();
    await session.addSource({ kind: "window", name: "Game", preset: "med", windowTitle: "A" });
    expect(states.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/main/session-controller.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/main/session/session-controller.ts`**

```ts
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ZodError } from "zod";
import type { BannerId, DashboardState, SettingsInput, SourceInput } from "../../shared/dashboard-api";
import type { IceServer, SourceStatus } from "../../shared/protocol";
import { slugify, uniqueSlug } from "../../shared/slug";
import { iceServersFromTurn, sourceInfoFromConfig } from "../../shared/source-info";
import { sourceConfigSchema, type HiveConfig, type SourceConfig } from "../config/config-store";
import type { Hub, Partner } from "../hub/hub";
import type { JoinHandle, JoinOptions, JoinStatus } from "../hub/joiner";
import { buildInviteLink, generateSecret } from "../invite";
import type { SpoutOutputKey } from "../spout/spout-output-plan";
import type { TunnelState } from "../tunnel/tunnel-manager";

export interface TunnelLike {
  readonly state: TunnelState;
  start(port: number): void;
  stop(): void;
  on(event: "state", listener: (state: TunnelState) => void): unknown;
}

export interface SessionDeps {
  config: HiveConfig;
  saveConfig(config: HiveConfig): Promise<void>;
  hub: Hub;
  port: number;
  tunnel: TunnelLike;
  join(opts: JoinOptions): JoinHandle;
  notifyPublisherSources(sources: SourceConfig[]): void;
  syncSpoutOutputs(partner: Partner | null, enabled: SpoutOutputKey[]): void;
  newId?: () => string;
}

const TERMINAL: ReadonlySet<JoinStatus> = new Set(["failed", "rejected", "stopped"]);

export class SessionController extends EventEmitter {
  private cfg: HiveConfig;
  private secret: string | null = null;
  private lastTunnelUrl: string | null = null;
  private joinHandle: JoinHandle | null = null;
  private joinState: DashboardState["join"] = { status: "idle", detail: null };
  private readonly banners = new Map<BannerId, string>();
  private readonly newId: () => string;

  constructor(private readonly deps: SessionDeps) {
    super();
    this.cfg = deps.config;
    this.newId = deps.newId ?? randomUUID;
    deps.hub.on("partner", (partner: Partner | null) => {
      deps.syncSpoutOutputs(partner, this.cfg.spoutOut);
      this.changed();
    });
    deps.hub.on("local-sources", () => this.changed());
    deps.hub.on("watchers", () => this.changed());
    deps.hub.on("health", (struggling: boolean) => {
      if (struggling) this.banners.set("upload-struggling", "Upload is struggling — lower a source's quality preset.");
      else this.banners.delete("upload-struggling");
      this.changed();
    });
    deps.hub.on("p2p-failed", () =>
      this.banner("p2p-failed", "Direct connection failed — add a TURN server in Settings."),
    );
    deps.tunnel.on("state", (s) => this.onTunnel(s));
    if (deps.port !== 7420) {
      this.banners.set("port-fallback", `Port 7420 was busy, so Hive is using ${deps.port}. OBS URLs use this port.`);
    }
  }

  get config(): HiveConfig {
    return this.cfg;
  }

  /** Current invite secret; null when not hosting (Hub rejects every hello). */
  get inviteSecret(): string | null {
    return this.secret;
  }

  get iceServers(): IceServer[] {
    return iceServersFromTurn(this.cfg.turn);
  }

  state(): DashboardState {
    const statuses = new Map<string, SourceStatus>(this.deps.hub.sources.map((s) => [s.id, s.status]));
    const tunnel = this.deps.tunnel.state;
    const partner = this.deps.hub.partner;
    return {
      displayName: this.cfg.displayName,
      port: this.deps.port,
      server: {
        status: tunnel.status,
        inviteLink: tunnel.status === "up" && this.secret ? buildInviteLink(tunnel.url, this.secret) : null,
      },
      join: { ...this.joinState },
      partner: partner ? { name: partner.name, slug: partner.slug, sources: partner.sources } : null,
      sources: this.cfg.sources.map((s) => ({ ...s, status: statuses.get(s.id) ?? "idle" })),
      watchers: this.deps.hub.watcherCounts(),
      spoutOut: this.cfg.spoutOut,
      banners: [...this.banners].map(([id, message]) => ({ id, message })),
      settings: { turn: this.cfg.turn, keepSecret: this.cfg.keepSecret },
    };
  }

  // ------------------------------------------------------------------ server

  startServer(): void {
    const status = this.deps.tunnel.state.status;
    if (status !== "stopped" && status !== "failed") return;
    this.secret = this.cfg.keepSecret && this.cfg.secret ? this.cfg.secret : generateSecret();
    if (this.cfg.keepSecret && this.cfg.secret !== this.secret) void this.persist({ ...this.cfg, secret: this.secret });
    this.banners.delete("tunnel-failed");
    this.deps.tunnel.start(this.deps.port);
    this.changed();
  }

  stopServer(): void {
    this.deps.tunnel.stop();
    this.secret = null;
    this.lastTunnelUrl = null;
    this.banners.delete("invite-changed");
    this.changed();
  }

  // ------------------------------------------------------------------- join

  join(link: string): void {
    this.stopJoin();
    this.joinState = { status: "connecting", detail: null };
    let handle: JoinHandle | null = null;
    handle = this.deps.join({
      hub: this.deps.hub,
      invite: link,
      onStatus: (status, detail) => {
        this.joinState = { status, detail: detail ?? null };
        if (TERMINAL.has(status) && handle !== null && this.joinHandle === handle) this.joinHandle = null;
        this.changed();
      },
    });
    if (!TERMINAL.has(this.joinState.status as JoinStatus)) this.joinHandle = handle;
    this.changed();
  }

  leave(): void {
    this.stopJoin();
    this.joinState = { status: "idle", detail: null };
    this.changed();
  }

  kick(): void {
    this.deps.hub.kick();
  }

  // ---------------------------------------------------------------- sources

  async addSource(input: SourceInput): Promise<void> {
    const source = this.toConfig(this.newId(), input, this.cfg.sources);
    await this.applySources([...this.cfg.sources, source]);
  }

  async updateSource(id: string, input: SourceInput): Promise<void> {
    const existing = this.cfg.sources.find((s) => s.id === id);
    if (!existing) throw new Error("Source not found.");
    if (existing.kind !== input.kind) throw new Error("A source's type can't be changed.");
    const updated = this.toConfig(id, input, this.cfg.sources.filter((s) => s.id !== id));
    await this.applySources(this.cfg.sources.map((s) => (s.id === id ? updated : s)));
  }

  async removeSource(id: string): Promise<void> {
    await this.applySources(this.cfg.sources.filter((s) => s.id !== id));
  }

  // -------------------------------------------------------------- spout out

  async setSpoutOut(partnerSlug: string, sourceSlug: string, enabled: boolean): Promise<void> {
    const rest = this.cfg.spoutOut.filter((k) => !(k.partnerSlug === partnerSlug && k.sourceSlug === sourceSlug));
    await this.persist({ ...this.cfg, spoutOut: enabled ? [...rest, { partnerSlug, sourceSlug }] : rest });
    this.deps.syncSpoutOutputs(this.deps.hub.partner, this.cfg.spoutOut);
    this.changed();
  }

  /** Spec §10: a failed Spout output reverts its toggle and reports inline. */
  reportSpoutOutputError(key: string, error: Error): void {
    const [partnerSlug = "", sourceSlug = ""] = key.split("/");
    this.banner("spout-output-failed", `Spout output failed: ${error.message}`);
    void this.setSpoutOut(partnerSlug, sourceSlug, false);
  }

  // --------------------------------------------------------------- settings

  async updateSettings(input: SettingsInput): Promise<void> {
    const displayName = input.displayName.trim();
    if (displayName.length < 1 || displayName.length > 64) throw new Error("Display name must be 1–64 characters.");
    const url = input.turn?.url.trim() ?? "";
    const turn = input.turn && url ? { url, username: input.turn.username, credential: input.turn.credential } : null;
    if (turn && !/^turns?:/.test(turn.url)) throw new Error("TURN URL must start with turn: or turns:");
    const secret = input.keepSecret ? (this.cfg.secret ?? this.secret ?? generateSecret()) : null;
    await this.persist({ ...this.cfg, displayName, turn, keepSecret: input.keepSecret, secret });
    this.deps.hub.setDisplayName(displayName);
    this.changed();
  }

  dismissBanner(id: BannerId): void {
    this.banners.delete(id);
    this.changed();
  }

  async saveWindowBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    await this.persist({ ...this.cfg, windowBounds: bounds });
  }

  dispose(): void {
    this.stopJoin();
    this.deps.tunnel.stop();
  }

  // ---------------------------------------------------------------- private

  private stopJoin(): void {
    const handle = this.joinHandle;
    this.joinHandle = null;
    handle?.stop();
  }

  private toConfig(id: string, input: SourceInput, others: SourceConfig[]): SourceConfig {
    const name = input.name.trim();
    if (input.kind === "url") {
      let protocol = "";
      try {
        protocol = new URL(input.url).protocol;
      } catch {
        protocol = "";
      }
      if (protocol !== "http:" && protocol !== "https:") throw new Error("URL must start with http:// or https://");
    }
    const slug = uniqueSlug(slugify(name), new Set(others.map((s) => s.slug)));
    try {
      return sourceConfigSchema.parse({ ...input, name, id, slug });
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ");
        throw new Error(`Invalid source: ${detail}`);
      }
      throw err;
    }
  }

  private async applySources(sources: SourceConfig[]): Promise<void> {
    await this.persist({ ...this.cfg, sources });
    const statuses = new Map<string, SourceStatus>(this.deps.hub.sources.map((s) => [s.id, s.status]));
    this.deps.hub.setLocalSources(sources.map((s) => sourceInfoFromConfig(s, statuses.get(s.id) ?? "idle")));
    this.deps.notifyPublisherSources(sources);
    this.changed();
  }

  private onTunnel(state: TunnelState): void {
    if (state.status === "up") {
      if (this.lastTunnelUrl !== null && this.lastTunnelUrl !== state.url) {
        this.banners.set("invite-changed", "Your invite link changed — send the new link to your partner.");
      }
      this.lastTunnelUrl = state.url;
    }
    if (state.status === "failed") this.banners.set("tunnel-failed", `Couldn't start the tunnel (${state.error}).`);
    this.changed();
  }

  private banner(id: BannerId, message: string): void {
    this.banners.set(id, message);
    this.changed();
  }

  private async persist(config: HiveConfig): Promise<void> {
    this.cfg = config;
    await this.deps.saveConfig(config);
  }

  private changed(): void {
    this.emit("state", this.state());
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/main/session-controller.test.ts` → PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/session tests/main/session-controller.test.ts
git commit -m "feat: add SessionController for dashboard actions and state"
```

---

### Task 5: `/join` landing page and deep-link parsing

The invite link `https://<tunnel>/join#<secret>` opens this page in the partner's browser. The secret stays in the URL fragment, which browsers never send to servers. The page hands the whole link to the app through `hive://join?link=<encoded>` and also shows it for copy-paste.

**Files:**
- Create: `src/main/hub/join-page.ts`, `src/main/deep-link.ts`
- Test: `tests/main/join-page.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inviteFromArgv } from "../../src/main/deep-link";
import { Hub } from "../../src/main/hub/hub";
import { joinRoute } from "../../src/main/hub/join-page";
import { startLocalServer, type LocalServer } from "../../src/main/hub/local-server";

let server: LocalServer;
beforeAll(async () => {
  const hub = new Hub({ displayName: "A", getInviteSecret: () => null, getIceServers: () => [] });
  server = await startLocalServer({ hub, publisherToken: "T", ports: [0], httpRoutes: [joinRoute()] });
});
afterAll(async () => {
  await server.close();
});

describe("join page", () => {
  it("is reachable through the tunnel with safe headers", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/join`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("hive://join?link=");
    expect(html).toContain("Open in Hive");
  });
});

describe("inviteFromArgv", () => {
  it("extracts the invite from a hive:// argument", () => {
    const invite = "https://a.trycloudflare.com/join#S3cret";
    const argv = ["C:\\Hive\\Hive.exe", `hive://join?link=${encodeURIComponent(invite)}`];
    expect(inviteFromArgv(argv)).toBe(invite);
  });
  it("returns null without one", () => {
    expect(inviteFromArgv(["Hive.exe", "--profile=a"])).toBeNull();
    expect(inviteFromArgv(["Hive.exe", "hive://join"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (modules not found).

- [ ] **Step 3: Create `src/main/hub/join-page.ts`**

```ts
import type { HttpRoute } from "./local-server";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join on Hive</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1113; color: #e7e9ec; font: 15px system-ui, sans-serif; }
  main { width: min(460px, calc(100vw - 32px)); background: #171a1d; border: 1px solid #2a2f35; border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #8a939d; line-height: 1.5; }
  a.button { display: inline-block; background: #a855f7; color: #fff; font-weight: 600; text-decoration: none; padding: 10px 16px; border-radius: 8px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; border: 1px solid #2a2f35; background: #0f1113; color: #e7e9ec; font: inherit; }
</style>
</head>
<body>
<main>
  <h1>Join a Hive co-stream</h1>
  <p>Hive should open automatically. If it doesn't, click the button.</p>
  <p><a class="button" id="open" href="#">Open in Hive</a></p>
  <p>Or copy this link and paste it into Hive's join box:</p>
  <input id="link" readonly>
</main>
<script>
  var link = location.href;
  var deep = "hive://join?link=" + encodeURIComponent(link);
  document.getElementById("open").href = deep;
  var input = document.getElementById("link");
  input.value = link;
  input.addEventListener("focus", function () { input.select(); });
  location.href = deep;
</script>
</body>
</html>`;

/** GET /join — the only HTTP page reachable through the tunnel. */
export function joinRoute(): HttpRoute {
  return (req, res, ctx) => {
    if (req.method !== "GET" || ctx.path !== "/join") return false;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "x-frame-options": "DENY",
    });
    res.end(PAGE);
    return true;
  };
}
```

- [ ] **Step 4: Create `src/main/deep-link.ts`**

```ts
export const PROTOCOL = "hive";

/** Finds `hive://join?link=<encoded invite>` in argv (Windows passes deep links as arguments). */
export function inviteFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (!arg) return null;
  try {
    return new URL(arg).searchParams.get("link");
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run to verify it passes** → PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/hub/join-page.ts src/main/deep-link.ts tests/main/join-page.test.ts
git commit -m "feat: add /join landing page and hive:// deep link parsing"
```

---

### Task 6: Main wiring — IPC, dashboard window, app core, entry

**Files:**
- Create: `src/main/dashboard-ipc.ts`, `src/main/dashboard-window.ts`, `src/preload/dashboard.ts`
- Replace: `src/main/app-core.ts`, `src/main/index.ts`
- Modify: `electron.vite.config.ts`

- [ ] **Step 1: Create `src/main/dashboard-ipc.ts`**

```ts
import { clipboard, ipcMain } from "electron";
import type { BannerId, CapturableWindow, SettingsInput, SourceInput } from "../shared/dashboard-api";
import type { SessionController } from "./session/session-controller";

const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("expected a string");
  return v;
};

export function registerDashboardIpc(
  session: SessionController,
  extra: { listWindows(): Promise<CapturableWindow[]>; listSpoutSenders(): string[] },
): void {
  const on = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`hive:dash:${name}`, (_e, ...args: unknown[]) => fn(...args));
  };
  on("get-state", () => session.state());
  on("start-server", () => session.startServer());
  on("stop-server", () => session.stopServer());
  on("join", (link) => session.join(str(link)));
  on("leave", () => session.leave());
  on("kick", () => session.kick());
  on("add-source", (input) => session.addSource(input as SourceInput));
  on("update-source", (id, input) => session.updateSource(str(id), input as SourceInput));
  on("remove-source", (id) => session.removeSource(str(id)));
  on("set-spout-out", (p, s, enabled) => session.setSpoutOut(str(p), str(s), enabled === true));
  on("update-settings", (input) => session.updateSettings(input as SettingsInput));
  on("dismiss-banner", (id) => session.dismissBanner(str(id) as BannerId));
  on("list-windows", () => extra.listWindows());
  on("list-spout-senders", () => extra.listSpoutSenders());
  on("copy", (text) => clipboard.writeText(str(text)));
}
```

`SourceInput` and `SettingsInput` are validated inside `SessionController` (schema parse and explicit checks), so malformed objects are rejected there.

- [ ] **Step 2: Create `src/preload/dashboard.ts`**

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { DashboardApi, DashboardState } from "../shared/dashboard-api";

const invoke = <T = void>(name: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`hive:dash:${name}`, ...args) as Promise<T>;

const api: DashboardApi = {
  getState: () => invoke<DashboardState>("get-state"),
  onState: (listener) => {
    ipcRenderer.on("hive:dash:state", (_e, state: DashboardState) => listener(state));
  },
  startServer: () => invoke("start-server"),
  stopServer: () => invoke("stop-server"),
  join: (link) => invoke("join", link),
  leave: () => invoke("leave"),
  kick: () => invoke("kick"),
  addSource: (input) => invoke("add-source", input),
  updateSource: (id, input) => invoke("update-source", id, input),
  removeSource: (id) => invoke("remove-source", id),
  setSpoutOut: (partnerSlug, sourceSlug, enabled) => invoke("set-spout-out", partnerSlug, sourceSlug, enabled),
  updateSettings: (input) => invoke("update-settings", input),
  dismissBanner: (id) => invoke("dismiss-banner", id),
  listWindows: () => invoke("list-windows"),
  listSpoutSenders: () => invoke("list-spout-senders"),
  copy: (text) => invoke("copy", text),
};

contextBridge.exposeInMainWorld("hive", api);
```

- [ ] **Step 3: Create `src/main/dashboard-window.ts`**

```ts
import { join } from "node:path";
import { BrowserWindow } from "electron";
import type { HiveConfig } from "./config/config-store";

export function createDashboardWindow(bounds: HiveConfig["windowBounds"]): BrowserWindow {
  const win = new BrowserWindow({
    width: bounds?.width ?? 980,
    height: bounds?.height ?? 680,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 520,
    title: "Hive",
    backgroundColor: "#0f1113",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/dashboard.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(`${devUrl}/dashboard/index.html`);
  else void win.loadFile(join(__dirname, "../renderer/dashboard/index.html"));
  return win;
}
```

- [ ] **Step 4: Replace `src/main/app-core.ts`**

This consolidates Plans 2–3 wiring and adds the SessionController, tunnel, dashboard and `/join`.

```ts
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";
import type { DashboardState } from "../shared/dashboard-api";
import { PRESETS } from "../shared/presets";
import { DEFAULT_ICE_SERVERS, sourceInfoFromConfig } from "../shared/source-info";
import { installDisplayMediaHandler, listCapturableWindows } from "./capture/display-media";
import { loadConfig, saveConfig } from "./config/config-store";
import { registerDashboardIpc } from "./dashboard-ipc";
import { createDashboardWindow } from "./dashboard-window";
import { Hub } from "./hub/hub";
import { joinRoute } from "./hub/join-page";
import { joinPartner } from "./hub/joiner";
import { startLocalServer, type LocalServer } from "./hub/local-server";
import { viewerRoute } from "./hub/static-files";
import { createPublisherWindow } from "./publisher-window";
import { SessionController } from "./session/session-controller";
import { SpoutInputs } from "./spout/spout-inputs";
import { desiredOutputs } from "./spout/spout-output-plan";
import { SpoutOutputs } from "./spout/spout-outputs";
import { TunnelManager } from "./tunnel/tunnel-manager";
import { UrlSources } from "./url-sources";

export interface RunningApp {
  session: SessionController;
  hub: Hub;
  server: LocalServer;
  dashboard: BrowserWindow;
  publisher: BrowserWindow;
  focus(): void;
  dispose(): void;
}

export function devOrigins(): string[] {
  const dev = process.env.ELECTRON_RENDERER_URL;
  return ["file://", ...(dev ? [new URL(dev).origin] : [])];
}

export function cloudflaredPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "cloudflared.exe")
    : join(app.getAppPath(), "resources", "cloudflared.exe");
}

export async function startApp(): Promise<RunningApp> {
  const configPath = join(app.getPath("userData"), "config.json");
  const config = await loadConfig(configPath);

  let session: SessionController | null = null;
  const hub = new Hub({
    displayName: config.displayName,
    getInviteSecret: () => session?.inviteSecret ?? null,
    getIceServers: () => session?.iceServers ?? DEFAULT_ICE_SERVERS,
  });
  hub.setLocalSources(config.sources.map((s) => sourceInfoFromConfig(s, "idle")));

  const publisherToken = randomBytes(24).toString("base64url");
  const server = await startLocalServer({
    hub,
    publisherToken,
    extraOrigins: devOrigins(),
    httpRoutes: [joinRoute(), viewerRoute(join(__dirname, "../viewer"))],
  });

  installDisplayMediaHandler();
  const publisher = createPublisherWindow({ port: server.port, token: publisherToken });
  const publisherContents = () => (publisher.isDestroyed() ? null : publisher.webContents);

  const spoutInputs = new SpoutInputs(publisherContents);
  spoutInputs.start();
  spoutInputs.on("availability", (name: string, available: boolean) => {
    publisherContents()?.send("hive:publisher:spout-availability", name, available);
  });
  const urlSources = new UrlSources(publisherContents);
  const spoutOutputs = new SpoutOutputs(
    () => `http://127.0.0.1:${server.port}`,
    (key, err) => session?.reportSpoutOutputError(key, err),
  );
  const tunnel = new TunnelManager({ binaryPath: cloudflaredPath() });

  const controller = new SessionController({
    config,
    saveConfig: (c) => saveConfig(configPath, c),
    hub,
    port: server.port,
    tunnel,
    join: joinPartner,
    notifyPublisherSources: (sources) => publisherContents()?.send("hive:publisher:sources", sources),
    syncSpoutOutputs: (partner, enabled) => void spoutOutputs.sync(desiredOutputs(partner, enabled)),
  });
  session = controller;

  // Publisher IPC (Plans 2–3), now reading live config from the session.
  ipcMain.handle("hive:publisher:get-sources", () => controller.config.sources);
  ipcMain.handle("hive:publisher:spout-senders", () => spoutInputs.senders());
  ipcMain.handle("hive:publisher:spout-open", (_e, sourceId: string, senderName: string) => {
    spoutInputs.open(sourceId, senderName);
  });
  ipcMain.handle("hive:publisher:spout-close", (_e, sourceId: string) => spoutInputs.close(sourceId));
  ipcMain.handle("hive:publisher:url-open", (_e, sourceId: string) => {
    const s = controller.config.sources.find((x) => x.id === sourceId);
    if (!s || s.kind !== "url") throw new Error(`unknown url source ${sourceId}`);
    urlSources.open(s.id, s.url, s.width, s.height, PRESETS[s.preset].fps);
  });
  ipcMain.handle("hive:publisher:url-close", (_e, sourceId: string) => urlSources.close(sourceId));

  registerDashboardIpc(controller, {
    listWindows: listCapturableWindows,
    listSpoutSenders: () => spoutInputs.senders(),
  });

  const dashboard = createDashboardWindow(config.windowBounds);
  controller.on("state", (state: DashboardState) => {
    if (!dashboard.isDestroyed()) dashboard.webContents.send("hive:dash:state", state);
  });
  dashboard.on("close", () => void controller.saveWindowBounds(dashboard.getBounds()));
  dashboard.on("closed", () => app.quit());

  return {
    session: controller,
    hub,
    server,
    dashboard,
    publisher,
    focus: () => {
      if (dashboard.isDestroyed()) return;
      if (dashboard.isMinimized()) dashboard.restore();
      dashboard.focus();
    },
    dispose: () => {
      controller.dispose();
      spoutOutputs.disposeAll();
      spoutInputs.dispose();
      urlSources.dispose();
      hub.dispose();
      void server.close();
    },
  };
}
```

- [ ] **Step 5: Replace `src/main/index.ts`**

```ts
import { join, resolve } from "node:path";
import { app } from "electron";
import { startApp, type RunningApp } from "./app-core";
import { PROTOCOL, inviteFromArgv } from "./deep-link";

const profile = process.argv.find((a) => a.startsWith("--profile="))?.slice("--profile=".length);
if (profile) app.setPath("userData", join(app.getPath("appData"), `Hive-${profile}`));

function registerProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerProtocol();
  let running: RunningApp | null = null;
  const devJoin = process.argv.find((a) => a.startsWith("--join="))?.slice("--join=".length) ?? null;
  const pendingInvite = inviteFromArgv(process.argv) ?? devJoin;

  app.on("second-instance", (_event, argv) => {
    if (!running) return;
    running.focus();
    const invite = inviteFromArgv(argv);
    if (invite) running.session.join(invite);
  });

  app.whenReady().then(async () => {
    running = await startApp();
    if (pendingInvite) running.session.join(pendingInvite);
  });

  app.on("before-quit", () => running?.dispose());
}
```

- [ ] **Step 6: Add the dashboard entries to `electron.vite.config.ts`**

```ts
  preload: {
    build: {
      rollupOptions: {
        input: {
          publisher: resolve(__dirname, "src/preload/publisher.ts"),
          dashboard: resolve(__dirname, "src/preload/dashboard.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      target: "chrome120",
      rollupOptions: {
        input: {
          publisher: resolve(__dirname, "src/renderer/publisher/index.html"),
          dashboard: resolve(__dirname, "src/renderer/dashboard/index.html"),
        },
      },
    },
  },
```

The dashboard preload runs sandboxed. It imports only `electron` (the `dashboard-api` imports are type-only), which sandboxed preloads support.

- [ ] **Step 7: Create a placeholder dashboard page so the build passes (replaced in Task 7)**

`src/renderer/dashboard/index.html`: `<!doctype html><html><body><div id="app"></div><script type="module" src="./main.ts"></script></body></html>` and `src/renderer/dashboard/main.ts`: `export {};`.

- [ ] **Step 8: Verify** — `npm run typecheck && npm test && npm run build` exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/main src/preload/dashboard.ts src/renderer/dashboard electron.vite.config.ts
git commit -m "feat: wire SessionController, dashboard window, IPC and deep links"
```

---

### Task 7: Dashboard renderer

Implements the approved mockup (`.superpowers/brainstorm/384-1790033008/content/dashboard-layout-v3.html`) and palette (spec §5).

**Files:**
- Create/replace: `src/renderer/dashboard/index.html`, `styles.css`, `dom.ts`, `previews.ts`, `source-dialog.ts`, `settings-dialog.ts`, `main.ts`

- [ ] **Step 1: `src/renderer/dashboard/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: mediastream:; connect-src ws://127.0.0.1:* ws://localhost:*"
    />
    <title>Hive</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: `src/renderer/dashboard/styles.css`**

```css
:root {
  --bg: #0f1113;
  --surf: #171a1d;
  --surf2: #1e2226;
  --line: #2a2f35;
  --tx: #e7e9ec;
  --mut: #8a939d;
  --acc: #a855f7;
  --acc-tx: #ffffff;
  --ok: #4ade80;
  --bad: #f87171;
  --warn: #f59e0b;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--tx); font: 13px system-ui, "Segoe UI", sans-serif; }
button { font: inherit; cursor: pointer; border-radius: 6px; padding: 6px 12px; white-space: nowrap; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.btn-primary { background: var(--acc); color: var(--acc-tx); border: 0; font-weight: 600; }
.btn-primary:disabled { background: var(--surf2); color: var(--mut); cursor: default; }
.btn-outline-ok { background: transparent; border: 1.5px solid var(--ok); color: var(--ok); font-weight: 600; }
.btn-outline-bad { background: transparent; border: 1.5px solid var(--bad); color: var(--bad); font-weight: 600; }
.btn-ghost { background: var(--surf2); color: var(--tx); border: 1px solid var(--line); }
.btn-ghost.danger { color: var(--bad); }
.spacer { flex: 1; }
.status { color: var(--mut); font-size: 12px; }
.top { display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: var(--surf); border-bottom: 1px solid var(--line); }
.invite-input { min-width: 24ch; padding: 6px 10px; border-radius: 6px; background: var(--bg); border: 1px solid var(--line); color: var(--tx); font: inherit; }
.banner { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: #2a1f0a; border-bottom: 1px solid var(--warn); color: var(--warn); }
.banner .msg { flex: 1; }
.tabs { display: flex; gap: 4px; padding: 10px 12px 0; border-bottom: 1px solid var(--line); }
.tab { background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--mut); padding: 7px 14px; margin-bottom: -1px; }
.tab.active { color: var(--tx); border-bottom-color: var(--acc); font-weight: 600; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin-left: 6px; vertical-align: middle; }
.body { padding: 12px; }
.partner-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.row { display: flex; gap: 10px; align-items: center; background: var(--surf); border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin-bottom: 8px; }
.thumb { position: relative; width: 96px; height: 54px; border-radius: 5px; flex: none; overflow: hidden; background: repeating-conic-gradient(#3a3f45 0 25%, #262a2f 0 50%) 0 0 / 10px 10px; }
.thumb video, .thumb canvas { width: 100%; height: 100%; object-fit: contain; display: block; }
.thumb .feeder { position: absolute; width: 2px; height: 2px; opacity: 0; }
.meta { flex: 1; min-width: 0; }
.meta b { display: block; margin-bottom: 2px; }
.meta .sub { display: block; color: var(--mut); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--surf2); color: var(--mut); margin-right: 4px; }
.tag.live { color: var(--ok); }
.tag.alpha { color: var(--acc); }
.tag.warn { color: var(--warn); }
.toggle { display: flex; align-items: center; gap: 6px; color: var(--mut); font-size: 12px; white-space: nowrap; margin: 0; }
.toggle input { width: auto; margin: 0; accent-color: var(--acc); }
.add { width: 100%; border: 1px dashed var(--line); background: none; color: var(--mut); padding: 10px; }
.empty { color: var(--mut); padding: 8px 0; }
dialog { background: var(--surf); color: var(--tx); border: 1px solid var(--line); border-radius: 10px; padding: 16px; width: min(560px, 92vw); }
dialog::backdrop { background: #000a; }
dialog h3 { margin: 0 0 8px; }
label { display: block; margin: 10px 0 4px; color: var(--mut); }
input, select { width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--tx); font: inherit; }
.hint { color: var(--mut); font-size: 12px; margin-top: 6px; }
.error { color: var(--bad); font-size: 12px; min-height: 1em; margin-top: 8px; }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.windows { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; max-height: 240px; overflow: auto; }
.win { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px; text-align: left; color: var(--tx); }
.win.selected { border-color: var(--acc); }
.win img { width: 100%; display: block; border-radius: 4px; }
.win span { display: block; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 4px; }
```

- [ ] **Step 3: `src/renderer/dashboard/dom.ts`**

```ts
export type Child = Node | string | null | undefined | false | Child[];

/** Tiny element builder. `on*` props become listeners; known properties are set, others become attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (key in el) {
      Reflect.set(el, key, value);
    } else {
      el.setAttribute(key, String(value));
    }
  }
  const append = (c: Child): void => {
    if (Array.isArray(c)) c.forEach(append);
    else if (c !== null && c !== undefined && c !== false) el.append(c);
  };
  children.forEach(append);
  return el;
}
```

- [ ] **Step 4: `src/renderer/dashboard/previews.ts`**

```ts
import { AlphaUnpacker } from "../../web/alpha/alpha-unpacker";
import { ViewerClient } from "../../web/viewer-client";

interface Preview {
  el: HTMLDivElement;
  client: ViewerClient;
  stopLoop(): void;
}

/**
 * Live thumbnails. One ViewerClient per (peer, source), reused across re-renders.
 * Each preview is a real subscriber, so all of them pause while the window is hidden.
 */
export class PreviewPool {
  private readonly previews = new Map<string, Preview>();
  private paused = document.visibilityState === "hidden";

  constructor(private readonly port: () => number) {
    document.addEventListener("visibilitychange", () => {
      this.paused = document.visibilityState === "hidden";
      for (const p of this.previews.values()) {
        if (this.paused) {
          p.client.stop();
          p.stopLoop();
        } else {
          p.client.start();
        }
      }
    });
  }

  get(peer: string, slug: string): HTMLDivElement {
    const key = `${peer}/${slug}`;
    const existing = this.previews.get(key);
    if (existing) return existing.el;

    const el = document.createElement("div");
    el.className = "thumb";
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    let unpacker: AlphaUnpacker | null = null;
    let raf = 0;
    const stopLoop = (): void => cancelAnimationFrame(raf);

    const client = new ViewerClient({
      url: `ws://127.0.0.1:${this.port()}/local/viewer`,
      peer,
      source: slug,
      onStream: (stream, info) => {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
        stopLoop();
        if (info.alpha) {
          video.className = "feeder";
          unpacker ??= new AlphaUnpacker(canvas);
          el.replaceChildren(video, canvas);
          const tick = (): void => {
            try {
              unpacker?.draw(video, video.videoWidth, video.videoHeight);
            } finally {
              raf = requestAnimationFrame(tick);
            }
          };
          raf = requestAnimationFrame(tick);
        } else {
          video.className = "";
          el.replaceChildren(video);
        }
      },
      onIdle: () => {
        stopLoop();
        video.srcObject = null;
        el.replaceChildren();
      },
    });
    if (!this.paused) client.start();
    this.previews.set(key, { el, client, stopLoop });
    return el;
  }

  /** Stop previews that are no longer rendered. */
  retain(keys: ReadonlySet<string>): void {
    for (const [key, p] of [...this.previews]) {
      if (keys.has(key)) continue;
      p.client.stop();
      p.stopLoop();
      this.previews.delete(key);
    }
  }
}
```

- [ ] **Step 5: `src/renderer/dashboard/source-dialog.ts`**

```ts
import type { DashboardApi, LocalSource, SourceInput } from "../../shared/dashboard-api";
import { DEFAULT_PRESET, type Preset } from "../../shared/presets";
import type { SourceKind } from "../../shared/protocol";
import { h } from "./dom";

const KIND_LABELS: Record<SourceKind, string> = {
  window: "Window / Screen",
  webcam: "Webcam",
  spout: "Spout2",
  url: "Browser URL",
};

const PRESET_LABELS: Record<Preset, string> = {
  low: "Low — 720p 30fps",
  med: "Medium — 1080p 30fps",
  high: "High — 1080p 60fps",
};

export function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    // Unlocks device labels; fails harmlessly if every camera is busy.
    const probe = await navigator.mediaDevices.getUserMedia({ video: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    // Labels may be blank.
  }
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
}

export class SourceDialog {
  private readonly dialog = h("dialog");
  private readonly name = h("input", { type: "text", maxLength: 64, placeholder: "Game" });
  private readonly kindSelect = h("select", { "aria-label": "Type" });
  private readonly presetSelect = h("select", { "aria-label": "Quality" });
  private readonly detail = h("div");
  private readonly error = h("div", { class: "error", role: "alert" });
  private readonly deviceSelect = h("select", { "aria-label": "Camera" });
  private readonly senderSelect = h("select", { "aria-label": "Spout2 sender" });
  private readonly url = h("input", { type: "url", placeholder: "https://…", "aria-label": "URL" });
  private readonly width = h("input", { type: "number", min: "16", max: "3840", value: "1280", "aria-label": "Width" });
  private readonly height = h("input", { type: "number", min: "16", max: "2160", value: "720", "aria-label": "Height" });
  private editing: LocalSource | null = null;
  private kind: SourceKind = "window";
  private presetTouched = false;
  private selectedWindow = "";

  constructor(private readonly api: DashboardApi) {
    for (const k of Object.keys(KIND_LABELS) as SourceKind[]) this.kindSelect.append(h("option", { value: k }, KIND_LABELS[k]));
    for (const p of Object.keys(PRESET_LABELS) as Preset[]) this.presetSelect.append(h("option", { value: p }, PRESET_LABELS[p]));
    this.kindSelect.addEventListener("change", () => {
      this.kind = this.kindSelect.value as SourceKind;
      if (!this.presetTouched) this.presetSelect.value = DEFAULT_PRESET[this.kind];
      void this.renderDetail();
    });
    this.presetSelect.addEventListener("change", () => {
      this.presetTouched = true;
    });
    document.body.append(this.dialog);
  }

  open(existing: LocalSource | null): void {
    this.editing = existing;
    this.kind = existing?.kind ?? "window";
    this.presetTouched = existing !== null;
    this.selectedWindow = existing?.kind === "window" ? existing.windowTitle : "";
    this.error.textContent = "";
    this.name.value = existing?.name ?? "";
    this.kindSelect.value = this.kind;
    this.kindSelect.disabled = existing !== null;
    this.presetSelect.value = existing?.preset ?? DEFAULT_PRESET[this.kind];
    this.url.value = existing?.kind === "url" ? existing.url : "";
    this.width.value = String(existing?.kind === "url" ? existing.width : 1280);
    this.height.value = String(existing?.kind === "url" ? existing.height : 720);

    this.dialog.replaceChildren(
      h("h3", {}, existing ? `Edit ${existing.name}` : "Add source"),
      h("label", {}, "Name"),
      this.name,
      h("label", {}, "Type"),
      this.kindSelect,
      h("label", {}, "Quality"),
      this.presetSelect,
      this.detail,
      this.error,
      h(
        "div",
        { class: "actions" },
        existing ? h("button", { class: "btn-ghost danger", onclick: () => void this.remove() }, "Remove") : null,
        h("span", { class: "spacer" }),
        h("button", { class: "btn-ghost", onclick: () => this.dialog.close() }, "Cancel"),
        h("button", { class: "btn-primary", onclick: () => void this.save() }, existing ? "Save" : "Add source"),
      ),
    );
    void this.renderDetail();
    this.dialog.showModal();
  }

  private async renderDetail(): Promise<void> {
    const kind = this.kind;
    switch (kind) {
      case "window": {
        const grid = h("div", { class: "windows" }, h("div", { class: "status" }, "Loading windows…"));
        this.detail.replaceChildren(
          h("label", {}, "Window"),
          grid,
          h("div", { class: "hint" }, "Exclusive-fullscreen games capture as black — use borderless windowed, or share via OBS's Spout2 filter."),
        );
        const windows = await this.api.listWindows();
        if (this.kind !== kind) return;
        grid.replaceChildren(
          ...windows.map((w) => {
            const button = h(
              "button",
              {
                type: "button",
                class: w.title === this.selectedWindow ? "win selected" : "win",
                title: w.title,
                onclick: () => {
                  this.selectedWindow = w.title;
                  for (const el of grid.children) el.classList.toggle("selected", el === button);
                  if (!this.name.value) this.name.value = w.title.slice(0, 64);
                },
              },
              h("img", { src: w.thumbnail, alt: "" }),
              h("span", {}, w.title),
            );
            return button;
          }),
        );
        break;
      }
      case "webcam": {
        this.detail.replaceChildren(
          h("label", {}, "Camera"),
          this.deviceSelect,
          h("div", { class: "hint" }, "If OBS is already using this camera, add a Spout2 filter to it in OBS and share it as a Spout2 source instead."),
        );
        const cameras = await listCameras();
        if (this.kind !== kind) return;
        this.deviceSelect.replaceChildren(...cameras.map((c, i) => h("option", { value: c.deviceId }, c.label || `Camera ${i + 1}`)));
        if (this.editing?.kind === "webcam") this.deviceSelect.value = this.editing.deviceId;
        break;
      }
      case "spout": {
        this.detail.replaceChildren(
          h("label", {}, "Spout2 sender"),
          this.senderSelect,
          h("div", { class: "hint" }, "Transparency is shared automatically for Spout2 sources."),
        );
        const senders = await this.api.listSpoutSenders();
        if (this.kind !== kind) return;
        const current = this.editing?.kind === "spout" ? this.editing.senderName : null;
        const names = current && !senders.includes(current) ? [current, ...senders] : senders;
        this.senderSelect.replaceChildren(...names.map((n) => h("option", { value: n }, n)));
        if (names.length === 0) this.senderSelect.append(h("option", { value: "" }, "No Spout2 senders running"));
        if (current) this.senderSelect.value = current;
        break;
      }
      case "url":
        this.detail.replaceChildren(
          h("label", {}, "URL"),
          this.url,
          h("div", { class: "pair" }, h("div", {}, h("label", {}, "Width"), this.width), h("div", {}, h("label", {}, "Height"), this.height)),
        );
        break;
    }
  }

  private buildInput(): SourceInput | string {
    const name = this.name.value.trim();
    const preset = this.presetSelect.value as Preset;
    if (!name) return "Enter a name.";
    switch (this.kind) {
      case "window":
        return this.selectedWindow ? { kind: "window", name, preset, windowTitle: this.selectedWindow } : "Pick a window.";
      case "webcam": {
        const option = this.deviceSelect.selectedOptions[0];
        return option?.value
          ? { kind: "webcam", name, preset, deviceId: option.value, deviceLabel: option.textContent ?? "" }
          : "Pick a camera.";
      }
      case "spout":
        return this.senderSelect.value ? { kind: "spout", name, preset, senderName: this.senderSelect.value } : "Pick a Spout2 sender.";
      case "url":
        return {
          kind: "url",
          name,
          preset,
          url: this.url.value.trim(),
          width: Number(this.width.value),
          height: Number(this.height.value),
        };
    }
  }

  private async save(): Promise<void> {
    const input = this.buildInput();
    if (typeof input === "string") {
      this.error.textContent = input;
      return;
    }
    try {
      if (this.editing) await this.api.updateSource(this.editing.id, input);
      else await this.api.addSource(input);
      this.dialog.close();
    } catch (err) {
      this.error.textContent = cleanError(err);
    }
  }

  private async remove(): Promise<void> {
    if (!this.editing) return;
    await this.api.removeSource(this.editing.id);
    this.dialog.close();
  }
}
```

- [ ] **Step 6: `src/renderer/dashboard/settings-dialog.ts`**

```ts
import type { DashboardApi, DashboardState } from "../../shared/dashboard-api";
import { h } from "./dom";
import { cleanError } from "./source-dialog";

export class SettingsDialog {
  private readonly dialog = h("dialog");
  private readonly name = h("input", { type: "text", maxLength: 64 });
  private readonly turnUrl = h("input", { type: "text", placeholder: "turn:turn.example.com:3478" });
  private readonly turnUser = h("input", { type: "text", autocomplete: "off" });
  private readonly turnCredential = h("input", { type: "password", autocomplete: "off" });
  private readonly keepSecret = h("input", { type: "checkbox" });
  private readonly error = h("div", { class: "error", role: "alert" });

  constructor(private readonly api: DashboardApi) {
    document.body.append(this.dialog);
  }

  open(state: DashboardState): void {
    this.name.value = state.displayName;
    this.turnUrl.value = state.settings.turn?.url ?? "";
    this.turnUser.value = state.settings.turn?.username ?? "";
    this.turnCredential.value = state.settings.turn?.credential ?? "";
    this.keepSecret.checked = state.settings.keepSecret;
    this.error.textContent = "";
    this.dialog.replaceChildren(
      h("h3", {}, "Settings"),
      h("label", {}, "Display name"),
      this.name,
      h("div", { class: "hint" }, "Your partner sees this name. Changes apply the next time you connect."),
      h("label", {}, "TURN server (optional)"),
      this.turnUrl,
      h("div", { class: "pair" }, h("div", {}, h("label", {}, "Username"), this.turnUser), h("div", {}, h("label", {}, "Credential"), this.turnCredential)),
      h("div", { class: "hint" }, "Only needed if Hive says the direct connection failed."),
      h("label", { class: "toggle" }, this.keepSecret, "Keep my invite link's secret the same between sessions"),
      this.error,
      h(
        "div",
        { class: "actions" },
        h("span", { class: "spacer" }),
        h("button", { class: "btn-ghost", onclick: () => this.dialog.close() }, "Cancel"),
        h("button", { class: "btn-primary", onclick: () => void this.save() }, "Save"),
      ),
    );
    this.dialog.showModal();
  }

  private async save(): Promise<void> {
    const url = this.turnUrl.value.trim();
    try {
      await this.api.updateSettings({
        displayName: this.name.value,
        turn: url ? { url, username: this.turnUser.value, credential: this.turnCredential.value } : null,
        keepSecret: this.keepSecret.checked,
      });
      this.dialog.close();
    } catch (err) {
      this.error.textContent = cleanError(err);
    }
  }
}
```

- [ ] **Step 7: `src/renderer/dashboard/main.ts`**

```ts
import "../../shared/dashboard-api";
import { spoutOutputName } from "../../main/spout/spout-output-plan";
import type { DashboardState, LocalSource } from "../../shared/dashboard-api";
import type { SourceInfo, SourceStatus } from "../../shared/protocol";
import { h } from "./dom";
import { PreviewPool } from "./previews";
import { SettingsDialog } from "./settings-dialog";
import { SourceDialog, cleanError } from "./source-dialog";

const api = window.hive;
const root = document.getElementById("app") as HTMLDivElement;
let state: DashboardState = await api.getState();
let tab: "partner" | "mine" = state.partner ? "partner" : "mine";
let copied: string | null = null;
let joinError = "";

const previews = new PreviewPool(() => state.port);
const sourceDialog = new SourceDialog(api);
const settingsDialog = new SettingsDialog(api);
const inviteInput = h("input", { class: "invite-input", placeholder: "Paste partner's invite link…", spellcheck: false, "aria-label": "Partner's invite link" });
inviteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void doJoin();
});

api.onState((next) => {
  const hadPartner = state.partner !== null;
  state = next;
  if (!hadPartner && next.partner) tab = "partner";
  if (!next.partner && tab === "partner") tab = "mine";
  render();
});

async function doJoin(): Promise<void> {
  const link = inviteInput.value.trim();
  if (!link) return;
  joinError = "";
  try {
    await api.join(link);
    inviteInput.value = "";
  } catch (err) {
    joinError = cleanError(err);
  }
  render();
}

function copy(key: string, text: string): void {
  void api.copy(text);
  copied = key;
  render();
  setTimeout(() => {
    if (copied !== key) return;
    copied = null;
    render();
  }, 1200);
}

const viewerUrl = (peer: string, slug: string): string => `http://localhost:${state.port}/s/${peer}/${slug}`;
const watchable = (s: SourceStatus): boolean => s === "live" || s === "idle";

function statusTag(status: SourceStatus): HTMLElement {
  switch (status) {
    case "live":
      return h("span", { class: "tag live" }, "● live");
    case "idle":
      return h("span", { class: "tag" }, "ready");
    case "waiting":
      return h("span", { class: "tag warn" }, "waiting for sender");
    case "unavailable":
      return h("span", { class: "tag warn" }, "unavailable");
  }
}

function joinStatusText(): string {
  const { status, detail } = state.join;
  switch (status) {
    case "connecting":
      return "Joining…";
    case "reconnecting":
      return "Reconnecting…";
    case "failed":
      return detail === "invalid-link" ? "That invite link isn't valid." : "Couldn't reach your partner.";
    case "rejected":
      return (
        { "bad-secret": "That invite link has expired.", version: "Your partner is on a different Hive version.", full: "Your partner already has someone connected.", kicked: "Your partner disconnected you." }[
          detail ?? ""
        ] ?? "Your partner declined the connection."
      );
    default:
      return joinError;
  }
}

function renderBanners(): HTMLElement[] {
  return state.banners.map((b) =>
    h(
      "div",
      { class: "banner", role: "status" },
      h("span", { class: "msg" }, b.message),
      b.id === "tunnel-failed" ? h("button", { class: "btn-ghost", onclick: () => void api.startServer() }, "Retry") : null,
      h("button", { class: "btn-ghost", "aria-label": "Dismiss", onclick: () => void api.dismissBanner(b.id) }, "×"),
    ),
  );
}

function renderTop(): HTMLElement {
  const s = state.server;
  const running = s.status !== "stopped" && s.status !== "failed";
  const serverStatus = { stopped: "", starting: "Starting tunnel…", up: "", restarting: "Reconnecting tunnel…", failed: "" }[s.status];
  const joined = state.join.status === "connecting" || state.join.status === "connected" || state.join.status === "reconnecting";
  const joinText = joinStatusText();
  return h(
    "div",
    { class: "top" },
    running
      ? h("button", { class: "btn-outline-bad", onclick: () => void api.stopServer() }, "Stop Server")
      : h("button", { class: "btn-outline-ok", onclick: () => void api.startServer() }, "Start Server"),
    h(
      "button",
      { class: "btn-primary", disabled: !s.inviteLink, onclick: () => s.inviteLink && copy("invite", s.inviteLink) },
      copied === "invite" ? "Copied!" : "Copy invite link",
    ),
    serverStatus ? h("span", { class: "status" }, serverStatus) : null,
    h("span", { class: "spacer" }),
    joinText ? h("span", { class: "status" }, joinText) : null,
    joined
      ? h("button", { class: "btn-ghost", onclick: () => void api.leave() }, "Leave")
      : [inviteInput, h("button", { class: "btn-ghost", onclick: () => void doJoin() }, "Join")],
    h("button", { class: "btn-ghost", title: "Settings", "aria-label": "Settings", onclick: () => settingsDialog.open(state) }, "⚙"),
  );
}

function renderTabs(): HTMLElement {
  const tabButton = (id: "partner" | "mine", ...label: (string | HTMLElement)[]): HTMLElement =>
    h(
      "button",
      { class: tab === id ? "tab active" : "tab", role: "tab", "aria-selected": String(tab === id), onclick: () => ((tab = id), render()) },
      ...label,
    );
  return h(
    "div",
    { class: "tabs", role: "tablist" },
    state.partner ? tabButton("partner", state.partner.name, h("span", { class: "dot", "aria-hidden": "true" })) : null,
    tabButton("mine", `My sources (${state.sources.length})`),
  );
}

function partnerRow(partner: NonNullable<DashboardState["partner"]>, src: SourceInfo, keys: Set<string>): HTMLElement {
  const key = `${partner.slug}/${src.slug}`;
  const canWatch = watchable(src.status);
  if (canWatch) keys.add(key);
  const spoutOn = state.spoutOut.some((k) => k.partnerSlug === partner.slug && k.sourceSlug === src.slug);
  return h(
    "div",
    { class: "row" },
    canWatch ? previews.get(partner.slug, src.slug) : h("div", { class: "thumb" }),
    h(
      "div",
      { class: "meta" },
      h("b", {}, src.name),
      h(
        "span",
        { class: "sub" },
        statusTag(src.status),
        src.alpha ? h("span", { class: "tag alpha" }, "alpha") : null,
        `${src.width}×${src.height} · ${src.fps}fps · OBS size ${src.width}×${src.height}`,
      ),
      spoutOn ? h("span", { class: "sub" }, `Spout sender: ${spoutOutputName(partner.name, src.name)}`) : null,
    ),
    h(
      "label",
      { class: "toggle" },
      h("input", {
        type: "checkbox",
        checked: spoutOn,
        onchange: (e: Event) => void api.setSpoutOut(partner.slug, src.slug, (e.target as HTMLInputElement).checked),
      }),
      "Spout out",
    ),
    h("button", { class: "btn-primary", onclick: () => copy(key, viewerUrl(partner.slug, src.slug)) }, copied === key ? "Copied!" : "Copy URL"),
  );
}

function renderPartner(partner: NonNullable<DashboardState["partner"]>, keys: Set<string>): HTMLElement {
  return h(
    "div",
    { class: "body" },
    h(
      "div",
      { class: "partner-head" },
      h("span", { class: "status" }, `Connected to ${partner.name}`),
      h("button", { class: "btn-ghost danger", onclick: () => void api.kick() }, "Disconnect partner"),
    ),
    partner.sources.length === 0 ? h("div", { class: "empty" }, `${partner.name} hasn't added any sources yet.`) : null,
    partner.sources.map((s) => partnerRow(partner, s, keys)),
  );
}

function detailOf(s: LocalSource): string {
  switch (s.kind) {
    case "window":
      return `Window: ${s.windowTitle}`;
    case "webcam":
      return s.deviceLabel || "Webcam";
    case "spout":
      return `Spout2: ${s.senderName}`;
    case "url":
      try {
        return new URL(s.url).host;
      } catch {
        return s.url;
      }
  }
}

function mineRow(s: LocalSource, keys: Set<string>): HTMLElement {
  const key = `me/${s.slug}`;
  const canWatch = watchable(s.status);
  if (canWatch) keys.add(key);
  const watching = state.watchers[s.id] ?? 0;
  return h(
    "div",
    { class: "row" },
    canWatch ? previews.get("me", s.slug) : h("div", { class: "thumb" }),
    h(
      "div",
      { class: "meta" },
      h("b", {}, s.name),
      h(
        "span",
        { class: "sub" },
        statusTag(s.status),
        h("span", { class: "tag" }, detailOf(s)),
        s.kind === "spout" ? h("span", { class: "tag alpha" }, "alpha") : null,
        `${s.preset === "low" ? "Low" : s.preset === "med" ? "Medium" : "High"}${watching ? ` · ${watching} watching` : ""}`,
      ),
    ),
    h("button", { class: "btn-ghost", onclick: () => sourceDialog.open(s) }, "Edit"),
  );
}

function renderMine(keys: Set<string>): HTMLElement {
  return h(
    "div",
    { class: "body" },
    state.sources.map((s) => mineRow(s, keys)),
    h("button", { class: "add", onclick: () => sourceDialog.open(null) }, "+ Add source"),
    state.partner ? null : h("div", { class: "empty" }, "No partners yet — start the server and send your invite link, or paste theirs."),
  );
}

function render(): void {
  const focused = document.activeElement === inviteInput;
  const selection = [inviteInput.selectionStart, inviteInput.selectionEnd] as const;
  const keys = new Set<string>();
  const content = tab === "partner" && state.partner ? renderPartner(state.partner, keys) : renderMine(keys);
  root.replaceChildren(...renderBanners(), renderTop(), renderTabs(), content);
  previews.retain(keys);
  if (focused) {
    inviteInput.focus();
    inviteInput.setSelectionRange(selection[0], selection[1]);
  }
}

render();
```

Importing `spoutOutputName` from `src/main/spout/spout-output-plan.ts` is safe in the renderer: that module has only type imports. Keep it that way; the dashboard e2e test in Task 8 fails the build if it ever pulls in Node code.

- [ ] **Step 8: Verify** — `npm run typecheck && npm run build` exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/dashboard
git commit -m "feat: add dashboard UI with tabs, previews, dialogs and banners"
```

---

### Task 8: Dashboard e2e with a mocked API

**Files:**
- Create: `tests/e2e/vite.dashboard.config.ts`, `tests/e2e/dashboard.e2e.test.ts`
- Modify: `.gitignore` (add `tests/e2e/.dashboard-dist/`)

- [ ] **Step 1: `tests/e2e/vite.dashboard.config.ts`**

```ts
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "../../src/renderer/dashboard"),
  base: "/dash/",
  logLevel: "warn",
  build: { outDir: resolve(__dirname, ".dashboard-dist"), emptyOutDir: true, target: "chrome120" },
});
```

- [ ] **Step 2: `tests/e2e/dashboard.e2e.test.ts`**

```ts
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hub } from "../../src/main/hub/hub";
import { startLocalServer, type LocalServer } from "../../src/main/hub/local-server";
import { staticRoute } from "../../src/main/hub/static-files";
import type { DashboardState } from "../../src/shared/dashboard-api";

const baseState: DashboardState = {
  displayName: "Ana",
  port: 7421,
  server: { status: "stopped", inviteLink: null },
  join: { status: "idle", detail: null },
  partner: {
    name: "Shady Penguinn",
    slug: "shady-penguinn",
    sources: [{ id: "a", name: "Game", slug: "game", kind: "window", alpha: false, width: 1920, height: 1080, fps: 30, status: "live" }],
  },
  sources: [],
  watchers: {},
  spoutOut: [],
  banners: [{ id: "port-fallback", message: "Port 7420 was busy, so Hive is using 7421." }],
  settings: { turn: null, keepSecret: false },
};

const mock = (state: DashboardState): string => `
  window.__calls = [];
  let st = ${JSON.stringify(state)};
  const listeners = [];
  const rec = (name) => (...args) => { window.__calls.push([name, ...args]); return Promise.resolve(); };
  window.hive = {
    getState: () => Promise.resolve(st),
    onState: (l) => listeners.push(l),
    startServer: rec("startServer"), stopServer: rec("stopServer"), join: rec("join"), leave: rec("leave"),
    kick: rec("kick"), addSource: rec("addSource"), updateSource: rec("updateSource"), removeSource: rec("removeSource"),
    setSpoutOut: rec("setSpoutOut"), updateSettings: rec("updateSettings"), dismissBanner: rec("dismissBanner"),
    listWindows: () => Promise.resolve([{ title: "melonDS", thumbnail: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }]),
    listSpoutSenders: () => Promise.resolve(["VSeeFace"]),
    copy: rec("copy"),
  };
  window.__push = (s) => { st = s; listeners.forEach((l) => l(s)); };
`;

let browser: Browser;
let server: LocalServer;

beforeAll(async () => {
  await build({ configFile: resolve(__dirname, "vite.dashboard.config.ts") });
  const hub = new Hub({ displayName: "T", getInviteSecret: () => null, getIceServers: () => [] });
  server = await startLocalServer({ hub, publisherToken: "T", ports: [0], httpRoutes: [staticRoute("/dash/", resolve(__dirname, ".dashboard-dist"))] });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(state: DashboardState = baseState): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript({ content: mock(state) });
  await page.goto(`http://127.0.0.1:${server.port}/dash/index.html`);
  await page.getByRole("button", { name: "Start Server" }).waitFor();
  return page;
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls);

describe("dashboard", () => {
  it("opens on the partner tab and copies a source URL", async () => {
    const page = await open();
    await expect(page.getByRole("tab", { name: /Shady Penguinn/ }).getAttribute("aria-selected")).resolves.toBe("true");
    await page.getByRole("button", { name: "Copy URL" }).click();
    expect(await calls(page)).toContainEqual(["copy", "http://localhost:7421/s/shady-penguinn/game"]);
    await expect(page.getByRole("button", { name: "Copied!" }).count()).resolves.toBe(1);
    await page.close();
  });

  it("shows banners and dismisses them", async () => {
    const page = await open();
    await page.getByText("Port 7420 was busy").waitFor();
    await page.getByRole("button", { name: "Dismiss" }).click();
    expect(await calls(page)).toContainEqual(["dismissBanner", "port-fallback"]);
    await page.close();
  });

  it("server button and invite reflect state", async () => {
    const page = await open();
    expect(await page.getByRole("button", { name: "Copy invite link" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Start Server" }).click();
    expect(await calls(page)).toContainEqual(["startServer"]);
    const up = { ...baseState, server: { status: "up", inviteLink: "https://a.trycloudflare.com/join#S" } };
    await page.evaluate((s) => (window as unknown as { __push: (x: unknown) => void }).__push(s), up);
    await page.getByRole("button", { name: "Stop Server" }).waitFor();
    await page.getByRole("button", { name: "Copy invite link" }).click();
    expect(await calls(page)).toContainEqual(["copy", "https://a.trycloudflare.com/join#S"]);
    await page.close();
  });

  it("typing in the invite box survives a state update, and Join sends it", async () => {
    const page = await open();
    const input = page.getByRole("textbox", { name: "Partner's invite link" });
    await input.click();
    await input.pressSequentially("https://b.trycloudflare.com/jo");
    await page.evaluate((s) => (window as unknown as { __push: (x: unknown) => void }).__push(s), { ...baseState, banners: [] });
    await input.pressSequentially("in#T");
    expect(await input.inputValue()).toBe("https://b.trycloudflare.com/join#T");
    await page.getByRole("button", { name: "Join" }).click();
    expect(await calls(page)).toContainEqual(["join", "https://b.trycloudflare.com/join#T"]);
    await page.close();
  });

  it("adds a browser URL source through the dialog", async () => {
    const page = await open();
    await page.getByRole("tab", { name: /My sources/ }).click();
    await page.getByRole("button", { name: "+ Add source" }).click();
    await page.getByRole("combobox", { name: "Type" }).selectOption("url");
    await page.locator("dialog input[type=text]").first().fill("Tracker");
    await page.getByRole("textbox", { name: "URL" }).fill("http://localhost:3000/");
    await page.getByRole("button", { name: "Add source" }).click();
    expect(await calls(page)).toContainEqual([
      "addSource",
      { kind: "url", name: "Tracker", preset: "low", url: "http://localhost:3000/", width: 1280, height: 720 },
    ]);
    await page.close();
  });

  it("toggles Spout out for a partner source", async () => {
    const page = await open();
    await page.getByRole("checkbox", { name: "Spout out" }).check();
    expect(await calls(page)).toContainEqual(["setSpoutOut", "shady-penguinn", "game", true]);
    await page.close();
  });
});
```

- [ ] **Step 3: Run**

Run: `npm run test:e2e`
Expected: all e2e files PASS, including 6 dashboard tests. The previews try `ws://127.0.0.1:7421` and fail quietly; that is expected with the mock.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/vite.dashboard.config.ts tests/e2e/dashboard.e2e.test.ts .gitignore
git commit -m "test: dashboard e2e with mocked API"
```

---

### Task 9: cloudflared download and Windows installer

**Files:**
- Create: `scripts/fetch-cloudflared.mjs`, `electron-builder.yml`
- Modify: `package.json`, `.gitignore`

- [ ] **Step 1: Create `scripts/fetch-cloudflared.mjs`**

Pinned version plus trust-on-first-download SHA-256 lock. The first run writes `scripts/cloudflared.lock.json`; commit it. Later runs refuse a binary whose hash differs.

```js
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.9.1";
const SOURCE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "resources", "cloudflared.exe");
const lockFile = join(root, "scripts", "cloudflared.lock.json");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const lock = existsSync(lockFile) ? JSON.parse(await readFile(lockFile, "utf8")) : null;
if (existsSync(out) && lock?.version === VERSION && sha256(await readFile(out)) === lock.sha256) {
  console.log(`cloudflared ${VERSION} already present`);
  process.exit(0);
}

console.log(`Downloading ${SOURCE}`);
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const hash = sha256(buf);
if (lock?.version === VERSION && lock.sha256 !== hash) {
  throw new Error(`cloudflared hash mismatch: expected ${lock.sha256}, got ${hash}`);
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
if (lock?.version !== VERSION) {
  await writeFile(lockFile, `${JSON.stringify({ version: VERSION, sha256: hash }, null, 2)}\n`);
  console.log(`Pinned sha256 ${hash} in scripts/cloudflared.lock.json — commit this file.`);
}
console.log(`cloudflared ${VERSION} -> resources/cloudflared.exe`);
```

- [ ] **Step 2: Create `electron-builder.yml`**

electron-builder 26 syntax. v27 moves `asarUnpack` to `asar.unpack`; `electron-builder migrate-schema` handles that when upgrading.

```yaml
appId: app.hive.costream
productName: Hive
directories:
  output: release
files:
  - out/**/*
  - package.json
asarUnpack:
  - "**/*.node"
  - "node_modules/@napolab/**"
extraResources:
  - from: resources/cloudflared.exe
    to: cloudflared.exe
protocols:
  - name: Hive invite
    schemes:
      - hive
win:
  target:
    - target: nsis
      arch:
        - x64
nsis:
  oneClick: true
  perMachine: false
  deleteAppDataOnUninstall: false
```

- [ ] **Step 3: Update `package.json`**

```bash
npm install --save-exact --save-dev electron-builder@26.15.3
```

Add scripts:

```json
"fetch:cloudflared": "node scripts/fetch-cloudflared.mjs",
"predev": "npm run fetch:cloudflared",
"dist": "npm run fetch:cloudflared && npm run build && electron-builder --win"
```

Append to `.gitignore`:

```
release/
resources/cloudflared.exe
```

- [ ] **Step 4: Fetch and check the binary**

Run: `npm run fetch:cloudflared` then `resources/cloudflared.exe --version`
Expected: `cloudflared version 2026.9.1 ...`, and `scripts/cloudflared.lock.json` is created.

- [ ] **Step 5: Build the installer**

Run: `npm run dist`
Expected: `release/Hive Setup 0.1.0.exe` exists. List `release/win-unpacked/resources`: it contains `cloudflared.exe`, and `app.asar.unpacked/node_modules/@napolab/texture-bridge-win32-x64-msvc/*.node` exists.

- [ ] **Step 6: Commit**

```bash
git add scripts electron-builder.yml package.json package-lock.json .gitignore
git commit -m "build: bundle pinned cloudflared and add Windows installer config"
```

---

### Task 10: End-to-end manual verification on two PCs

Use two Windows PCs on different networks (or one PC plus a phone hotspot for the second). Install `release/Hive Setup 0.1.0.exe` on both. Streamer A hosts; streamer B joins.

- [ ] **Step 1: First run.** Open Hive on both. Set display names in ⚙ Settings. Expected: the dashboard matches the approved mockup (graphite surfaces, purple primary buttons, green outline Start Server).
- [ ] **Step 2: Host.** A clicks **Start Server**. Expected: "Starting tunnel…", then the button turns to red **Stop Server** and **Copy invite link** enables. A copies the link and sends it to B.
- [ ] **Step 3: Join by link.** B clicks the link in a browser. Expected: the landing page opens Hive (protocol prompt the first time) and B shows "Joining…" then A's tab. Also test pasting the link into the Join box instead.
- [ ] **Step 4: Sources both ways.** Each adds a Window source, a Webcam, and (if available) a Spout2 VTuber. Expected: each sees the other's rows with live previews. Copy URL → OBS Browser Source at the shown OBS size → live video. The VTuber is transparent. "N watching" appears on the sender's rows.
- [ ] **Step 5: Spout out.** B toggles **Spout out** on A's VTuber and adds an OBS Spout2 Capture source `Hive - <A> - VTuber`. Expected: transparent model.
- [ ] **Step 6: Failure paths.**
  - Close the captured game window → the row shows "unavailable".
  - A clicks Stop Server → B reconnects for 60 s, then shows "Couldn't reach your partner."
  - Wrong/old invite → "That invite link has expired."
  - A clicks **Disconnect partner** → B shows "Your partner disconnected you."
  - Start OBS first holding the webcam → the webcam row shows "unavailable" and the hint text explains the Spout2 filter route.
- [ ] **Step 7: Persistence.** Restart both apps. Expected: sources, settings, Spout out toggles and window position restore. OBS URLs are unchanged, so the scenes work without edits after reconnecting.
- [ ] **Step 8: Record results** in the spec's Open risks (OBS H.264 decode, NAT/TURN needs, alpha edge quality) and commit:

```bash
git add docs/superpowers/specs/2026-09-21-hive-design.md
git commit -m "docs: record end-to-end verification results"
```

---

## Self-review notes (spec coverage for this plan)

| Spec item | Task |
|---|---|
| §3.2 local server always on; Start Server = tunnel; Join works while stopped | 4, 6 |
| §3.3 connect flow, invite link, landing page + `hive://` deep link | 4, 5, 6 |
| §5 top bar, tabs, rows, previews, Copy URL, Spout out toggle, Add/Edit source (types, pickers, hints), Kick, Settings, banners, palette | 7, 8 |
| §8 secret rotation per Start, keep-stable option, kick | 4, 7 |
| §9 persistence incl. spoutOut and window bounds | 4, 6 |
| §10 every banner row (tunnel changed/failed, P2P, port fallback, upload struggling, spout output failure) + join rejection reasons | 4, 7 |
| Packaging: bundled cloudflared, native addon unpacked, protocol | 9 |
| §11 manual checklist | 10 |
