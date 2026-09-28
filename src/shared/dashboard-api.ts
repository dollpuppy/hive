import type { Preset, SourceConfig } from "../main/config/config-store";
import type { JoinDetail, JoinStatus } from "../main/hub/joiner";
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
  | "spout-output-failed"
  | "publisher-down";

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
  join: { status: JoinStatus | "idle"; detail: JoinDetail | null };
  /**
   * The partner, live (`connected: true`) or kept through the Spout grace window after a plain
   * disconnect (`connected: false`, spec §10 "reconnecting…"); null once cleared.
   */
  partner: { name: string; slug: string; sources: SourceInfo[]; connected: boolean } | null;
  /** An invite from a hive:// deep link, offered to the user (never auto-joined); null when none. */
  pendingInvite: string | null;
  sources: LocalSource[];
  /** Partner viewers per local source id. */
  watchers: Record<string, number>;
  spoutOut: SpoutOutputKey[];
  /** Inline error per Spout output key ("<partnerSlug>/<sourceSlug>"), spec §10. */
  spoutOutErrors: Record<string, string>;
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
  retrySource(id: string): Promise<void>;
  setSpoutOut(partnerSlug: string, sourceSlug: string, enabled: boolean): Promise<void>;
  updateSettings(input: SettingsInput): Promise<void>;
  dismissBanner(id: BannerId): Promise<void>;
  /** Declines the offered deep-link invite (clears `pendingInvite`). */
  dismissInvite(): Promise<void>;
  listWindows(): Promise<CapturableWindow[]>;
  listSpoutSenders(): Promise<string[]>;
  copy(text: string): Promise<void>;
}

declare global {
  interface Window {
    hive: DashboardApi;
  }
}
