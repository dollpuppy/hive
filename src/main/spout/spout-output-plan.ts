import type { Partner } from "../hub/hub";

/** Hive's own Spout outputs; hidden from the input picker to avoid feedback loops. */
export const OWN_OUTPUT_PREFIX = "Hive - ";

/**
 * Spout sender names are stored in a fixed 256-byte buffer including a
 * trailing NUL terminator, so the usable name is at most 255 bytes.
 */
const MAX_SENDER_NAME_BYTES = 255;

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
 * Truncates a UTF-8 string to at most `maxBytes`, never splitting a
 * multi-byte code point. Partner/source names are remote-controlled, so the
 * composed sender name must be safely bounded before it reaches the native
 * Spout sender (whose name buffer is a fixed size).
 */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

export function spoutOutputName(partnerName: string, sourceName: string): string {
  const full = `${OWN_OUTPUT_PREFIX}${partnerName} - ${sourceName}`;
  return truncateUtf8(full, MAX_SENDER_NAME_BYTES);
}

export function desiredOutputs(partner: Partner | null, enabled: SpoutOutputKey[]): DesiredOutput[] {
  if (!partner) return [];
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
        name: spoutOutputName(partner.name, source.name),
        path: `/s/${encodeURIComponent(partner.slug)}/${encodeURIComponent(source.slug)}`,
        width: source.width,
        height: source.height,
        fps: source.fps,
      },
    ];
  });
}
