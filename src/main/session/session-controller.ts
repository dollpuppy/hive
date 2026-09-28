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
  /**
   * Spec §6.4: a partner disconnect with no reconnect (or a kick) is what should tear down
   * Spout outputs — a brief blip shouldn't make OBS lose the sender. Default 60 s.
   */
  spoutGraceMs?: number;
}

const TERMINAL: ReadonlySet<JoinStatus> = new Set(["failed", "rejected", "stopped"]);

export class SessionController extends EventEmitter {
  private cfg: HiveConfig;
  private secret: string | null = null;
  private lastTunnelUrl: string | null = null;
  private joinHandle: JoinHandle | null = null;
  private joinState: DashboardState["join"] = { status: "idle", detail: null };
  private readonly banners = new Map<BannerId, string>();
  private readonly spoutOutErrors = new Map<string, string>();
  private readonly newId: () => string;
  private readonly spoutGraceMs: number;
  private spoutGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by a kick (ours or theirs) or by `leave()`, so the next `partner: null` skips the grace period. */
  private kickOrLeavePending = false;

  constructor(private readonly deps: SessionDeps) {
    super();
    this.cfg = deps.config;
    this.newId = deps.newId ?? randomUUID;
    this.spoutGraceMs = deps.spoutGraceMs ?? 60_000;
    // Amendment 6: app-core used to clear a stray secret at startup; that now lives here.
    if (!this.cfg.keepSecret && this.cfg.secret !== null) void this.persist({ ...this.cfg, secret: null });
    deps.hub.on("partner", (partner: Partner | null) => this.onPartnerChanged(partner));
    deps.hub.on("local-sources", () => this.changed());
    deps.hub.on("watchers", () => this.changed());
    deps.hub.on("health", (struggling: boolean) => {
      if (struggling) this.banner("upload-struggling", "Upload is struggling — lower a source's quality preset.");
      else {
        this.banners.delete("upload-struggling");
        this.changed();
      }
    });
    deps.hub.on("p2p-failed", () =>
      this.banner("p2p-failed", "Direct connection failed — add a TURN server in Settings."),
    );
    deps.hub.on("publisher", (connected: boolean) => {
      if (connected) this.banners.delete("publisher-down");
      else this.banners.set("publisher-down", "Hive's capture engine stopped — your sources are offline until it restarts.");
      this.changed();
    });
    // Amendment 4: kick events precede the Hub's own `partner: null` (both emitted synchronously
    // by Hub.kick()/onPeerMessage's "kick" case), so this flag is already set by the time it matters.
    deps.hub.on("kicked", () => {
      this.kickOrLeavePending = true;
    });
    deps.hub.on("kicked-partner", () => {
      this.kickOrLeavePending = true;
    });
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
      spoutOutErrors: Object.fromEntries(this.spoutOutErrors),
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
        const next: DashboardState["join"] = { status, detail: detail ?? null };
        // Amendment 2: the joiner re-emits "connected" on every partner source-list change, and
        // "reconnecting" repeatedly; a duplicate status+detail is not a state change.
        if (next.status === this.joinState.status && next.detail === this.joinState.detail) return;
        this.joinState = next;
        if (TERMINAL.has(status) && handle !== null && this.joinHandle === handle) this.joinHandle = null;
        this.changed();
      },
    });
    if (!TERMINAL.has(this.joinState.status as JoinStatus)) this.joinHandle = handle;
    this.changed();
  }

  leave(): void {
    this.kickOrLeavePending = true;
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

  /** Amendment 1: re-pick/retry an `unavailable` source. CaptureManager resets it to idle on re-send. */
  async retrySource(id: string): Promise<void> {
    if (!this.cfg.sources.some((s) => s.id === id)) throw new Error("Source not found.");
    this.deps.notifyPublisherSources(this.cfg.sources);
  }

  // -------------------------------------------------------------- spout out

  async setSpoutOut(partnerSlug: string, sourceSlug: string, enabled: boolean): Promise<void> {
    const rest = this.cfg.spoutOut.filter((k) => !(k.partnerSlug === partnerSlug && k.sourceSlug === sourceSlug));
    await this.persist({ ...this.cfg, spoutOut: enabled ? [...rest, { partnerSlug, sourceSlug }] : rest });
    // Amendment 5: turning a toggle back on clears its previous inline error.
    if (enabled) this.spoutOutErrors.delete(`${partnerSlug}/${sourceSlug}`);
    this.deps.syncSpoutOutputs(this.deps.hub.partner, this.cfg.spoutOut);
    this.changed();
  }

  /** Spec §10: a failed Spout output reverts its toggle and reports inline. */
  reportSpoutOutputError(key: string, error: Error): void {
    const [partnerSlug = "", sourceSlug = ""] = key.split("/");
    this.spoutOutErrors.set(key, error.message);
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
    this.clearSpoutGrace();
    this.deps.tunnel.stop();
  }

  // ---------------------------------------------------------------- private

  private stopJoin(): void {
    const handle = this.joinHandle;
    this.joinHandle = null;
    handle?.stop();
  }

  /**
   * Amendment 4: a plain partner disconnect starts a grace period before Spout outputs are torn
   * down (a brief reconnect shouldn't make OBS lose the sender). A kick (either direction, via
   * the Hub's `kicked`/`kicked-partner` events) or our own `leave()` skips the grace period.
   */
  private onPartnerChanged(partner: Partner | null): void {
    if (partner) {
      this.clearSpoutGrace();
      this.deps.syncSpoutOutputs(partner, this.cfg.spoutOut);
      this.changed();
      return;
    }
    if (this.kickOrLeavePending) {
      this.kickOrLeavePending = false;
      this.clearSpoutGrace();
      this.deps.syncSpoutOutputs(null, this.cfg.spoutOut);
      this.changed();
      return;
    }
    this.changed();
    this.startSpoutGrace();
  }

  private startSpoutGrace(): void {
    if (this.spoutGraceTimer) return;
    this.spoutGraceTimer = setTimeout(() => {
      this.spoutGraceTimer = null;
      this.deps.syncSpoutOutputs(null, this.cfg.spoutOut);
      this.changed();
    }, this.spoutGraceMs);
  }

  private clearSpoutGrace(): void {
    if (this.spoutGraceTimer) clearTimeout(this.spoutGraceTimer);
    this.spoutGraceTimer = null;
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
