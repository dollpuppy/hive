export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Largest rect with the source's aspect ratio centred inside dw×dh. */
export function containRect(sw: number, sh: number, dw: number, dh: number): Rect {
  if (sw <= 0 || sh <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(dw / sw, dh / sh);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  return { x: Math.floor((dw - w) / 2), y: Math.floor((dh - h) / 2), w, h };
}
