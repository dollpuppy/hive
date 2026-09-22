import type { Preset } from "../main/config/config-store";
import type { SourceKind } from "./protocol";

export type { Preset };

export interface PresetSpec {
  width: number;
  height: number;
  fps: number;
  maxBitrate: number;
}

export const PRESETS: Record<Preset, PresetSpec> = {
  low: { width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 },
  med: { width: 1920, height: 1080, fps: 30, maxBitrate: 5_000_000 },
  high: { width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000 },
};

export const DEFAULT_PRESET: Record<SourceKind, Preset> = {
  window: "med",
  webcam: "low",
  spout: "low",
  url: "low",
};

export const ALPHA_BITRATE_MULTIPLIER = 1.6;

export interface EncodingParams {
  maxBitrate: number;
  maxFramerate: number;
}

export function encodingFor(preset: Preset, alpha: boolean): EncodingParams {
  const spec = PRESETS[preset];
  return {
    maxBitrate: Math.round(spec.maxBitrate * (alpha ? ALPHA_BITRATE_MULTIPLIER : 1)),
    maxFramerate: spec.fps,
  };
}

/** "detail" keeps resolution under congestion; "" lets WebRTC balance. */
export function contentHintFor(kind: SourceKind): "detail" | "" {
  return kind === "window" || kind === "url" ? "detail" : "";
}
