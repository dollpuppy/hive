import type { HiveConfig, SourceConfig } from "../main/config/config-store";
import { PRESETS } from "./presets";
import type { IceServer, SourceInfo, SourceStatus } from "./protocol";

export const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export function sourceInfoFromConfig(cfg: SourceConfig, status: SourceStatus): SourceInfo {
  const spec = PRESETS[cfg.preset];
  const size = cfg.kind === "url" ? { width: cfg.width, height: cfg.height } : { width: spec.width, height: spec.height };
  return {
    id: cfg.id,
    name: cfg.name,
    slug: cfg.slug,
    kind: cfg.kind,
    alpha: cfg.kind === "spout",
    ...size,
    fps: spec.fps,
    status,
  };
}

export function iceServersFromTurn(turn: HiveConfig["turn"]): IceServer[] {
  if (!turn || turn.url.trim() === "") return DEFAULT_ICE_SERVERS;
  return [...DEFAULT_ICE_SERVERS, { urls: turn.url.trim(), username: turn.username, credential: turn.credential }];
}
