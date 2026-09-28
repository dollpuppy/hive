import { PRESETS } from "../../shared/presets";
import { OWN_OUTPUT_PREFIX, spoutOutputName } from "../../shared/spout-name";
import { URL_SOURCE_MAX_HEIGHT, URL_SOURCE_MAX_WIDTH } from "../config/config-store";
import type { Partner } from "../hub/hub";

// Sender-name composition is pure and has no Node/main-process dependencies, so it lives in
// shared/spout-name.ts (the dashboard renderer imports it directly from there — it must not
// pull in this module's `node:*`/zod-backed config-store import). Re-exported here so existing
// main-process imports (spout-inputs.ts, tests) keep working unchanged.
export { OWN_OUTPUT_PREFIX, spoutOutputName };

/**
 * Bounds for partner-advertised sizes. The protocol accepts up to 7680×4320 @ 240 fps,
 * and these values size a native Spout sender and an offscreen renderer, so they are
 * clamped to the largest a Hive publisher can itself advertise: the URL-source size
 * maxima (the preset table tops out below them) and the fastest preset.
 */
const MAX_OUTPUT_WIDTH = Math.max(URL_SOURCE_MAX_WIDTH, ...Object.values(PRESETS).map((p) => p.width));
const MAX_OUTPUT_HEIGHT = Math.max(URL_SOURCE_MAX_HEIGHT, ...Object.values(PRESETS).map((p) => p.height));
const MAX_OUTPUT_FPS = Math.max(...Object.values(PRESETS).map((p) => p.fps));
const MIN_OUTPUT_DIMENSION = 16;

/**
 * Scales `width`×`height` down (never up) to fit the output bounds, preserving the
 * aspect ratio, then keeps each dimension an integer of at least 16.
 */
function clampSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_OUTPUT_WIDTH / width, MAX_OUTPUT_HEIGHT / height);
  const fit = (value: number, max: number): number =>
    Math.min(max, Math.max(MIN_OUTPUT_DIMENSION, Math.round(value * scale)));
  return { width: fit(width, MAX_OUTPUT_WIDTH), height: fit(height, MAX_OUTPUT_HEIGHT) };
}

export interface SpoutOutputKey {
  partnerSlug: string;
  sourceSlug: string;
}

export interface DesiredOutput {
  key: string;
  name: string;
  /** Viewer page path on the local server. */
  path: string;
  width: number;
  height: number;
  fps: number;
}

/**
 * The outputs to run for `partner`, in `enabled` order. Two sources with the same
 * display name (different slugs) would compose the same sender name, which Spout
 * can't hold twice: the second gets " (2)", the third " (3)", and so on, in the
 * partner's source-list order (not `enabled` order), so a source's name doesn't
 * depend on which outputs are turned on. Sizes and frame rates are clamped (see
 * `clampSize`), since they are partner-controlled.
 */
export function desiredOutputs(partner: Partner | null, enabled: SpoutOutputKey[]): DesiredOutput[] {
  if (!partner) return [];
  const names = uniqueNames(partner);
  const seen = new Set<string>();
  return enabled.flatMap((e) => {
    if (e.partnerSlug !== partner.slug) return [];
    const key = `${e.partnerSlug}/${e.sourceSlug}`;
    if (seen.has(key)) return [];
    const source = partner.sources.find((s) => s.slug === e.sourceSlug);
    if (!source) return [];
    seen.add(key);
    return [
      {
        key,
        name: names.get(source.slug) ?? spoutOutputName(partner.name, source.name),
        path: `/s/${encodeURIComponent(partner.slug)}/${encodeURIComponent(source.slug)}`,
        ...clampSize(source.width, source.height),
        fps: Math.min(source.fps, MAX_OUTPUT_FPS),
      },
    ];
  });
}

/** Sender name per source slug, numbered " (n)" where names (as truncated) collide. */
function uniqueNames(partner: Partner): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const s of partner.sources) {
    if (names.has(s.slug)) continue;
    let name = spoutOutputName(partner.name, s.name);
    for (let n = 2; used.has(name); n++) name = spoutOutputName(partner.name, s.name, ` (${n})`);
    used.add(name);
    names.set(s.slug, name);
  }
  return names;
}
