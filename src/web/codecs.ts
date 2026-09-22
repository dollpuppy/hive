export interface CodecLike {
  mimeType: string;
}

const RANK: Record<string, number> = { "video/h264": 0, "video/vp8": 1 };

/** Stable sort: H.264 first, VP8 second, everything else (incl. rtx/red/fec) after in original order. */
export function preferCodecs<T extends CodecLike>(codecs: readonly T[]): T[] {
  return codecs
    .map((codec, index) => ({ codec, index, rank: RANK[codec.mimeType.toLowerCase()] ?? 2 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.codec);
}
