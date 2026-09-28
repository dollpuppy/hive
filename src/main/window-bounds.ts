export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when the two rectangles share some area (merely touching edges doesn't count). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Saved window bounds, made safe to restore. Bounds overlapping some display's work area are
 * kept as they are. Otherwise (e.g. saved on a monitor that's since been unplugged) the position
 * is dropped, so the window centers, and the size is clamped to the primary display's work area.
 */
export function fitSavedBounds(
  bounds: Rect,
  workAreas: readonly Rect[],
  primaryWorkArea: Rect,
): { x?: number; y?: number; width: number; height: number } {
  if (workAreas.some((area) => intersects(bounds, area))) return bounds;
  return {
    width: Math.min(bounds.width, primaryWorkArea.width),
    height: Math.min(bounds.height, primaryWorkArea.height),
  };
}
