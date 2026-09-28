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
