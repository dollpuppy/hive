/**
 * Pure Spout-sender-name helpers with no Node or main-process dependencies, so the
 * dashboard renderer can import them directly (it must not pull in `node:*` or zod —
 * see spout-output-plan.ts, which re-exports these for the main process).
 */

/** Hive's own Spout outputs; hidden from the input picker to avoid feedback loops. */
export const OWN_OUTPUT_PREFIX = "Hive - ";

/**
 * Spout sender names are stored in a fixed 256-byte buffer including a
 * trailing NUL terminator, so the usable name is at most 255 bytes.
 */
export const MAX_SENDER_NAME_BYTES = 255;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Truncates a string to at most `maxBytes` of UTF-8, dropping whole code points so
 * a surrogate pair (e.g. an emoji) is never split. Partner/source names are
 * remote-controlled, so the composed sender name must be safely bounded before it
 * reaches the native Spout sender (whose name buffer is a fixed size).
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const points = Array.from(value);
  let bytes = 0;
  let end = 0;
  for (const p of points) {
    const n = byteLength(p);
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += 1;
  }
  return points.slice(0, end).join("");
}

/**
 * The Spout sender name for a partner source. `suffix` (e.g. " (2)", to tell apart
 * sources that share a display name) is kept whole: the base is truncated to make room.
 */
export function spoutOutputName(partnerName: string, sourceName: string, suffix = ""): string {
  const base = `${OWN_OUTPUT_PREFIX}${partnerName} - ${sourceName}`;
  return truncateUtf8(base, MAX_SENDER_NAME_BYTES - byteLength(suffix)) + suffix;
}

/**
 * Sender name per source slug, numbered " (n)" where names (as truncated) collide. Two sources
 * with the same display name (different slugs) would compose the same sender name, which Spout
 * can't hold twice: the second gets " (2)", the third " (3)", and so on, in `sources` order.
 * Used by both `spout-output-plan.ts` (to pick each output's real sender name) and the dashboard
 * renderer (to show the same name in a partner row, spec §10) — they must agree, so this lives
 * in one place rather than being duplicated.
 */
export function spoutOutputNames(partnerName: string, sources: readonly { slug: string; name: string }[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const s of sources) {
    if (names.has(s.slug)) continue;
    let name = spoutOutputName(partnerName, s.name);
    for (let n = 2; used.has(name); n++) name = spoutOutputName(partnerName, s.name, ` (${n})`);
    used.add(name);
    names.set(s.slug, name);
  }
  return names;
}
