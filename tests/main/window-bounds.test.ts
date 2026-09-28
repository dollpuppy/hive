import { describe, expect, it } from "vitest";
import { fitSavedBounds, intersects } from "../../src/main/window-bounds";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 2560, height: 1400 };

describe("intersects", () => {
  it("is true for overlapping rectangles and false for touching or disjoint ones", () => {
    expect(intersects({ x: 100, y: 100, width: 50, height: 50 }, primary)).toBe(true);
    expect(intersects({ x: -40, y: -40, width: 50, height: 50 }, primary)).toBe(true);
    expect(intersects({ x: 1920, y: 0, width: 50, height: 50 }, primary)).toBe(false);
    expect(intersects({ x: -50, y: 0, width: 50, height: 50 }, primary)).toBe(false);
    expect(intersects({ x: 0, y: 5000, width: 50, height: 50 }, primary)).toBe(false);
  });
});

describe("fitSavedBounds", () => {
  it("keeps bounds that are on some display", () => {
    const b = { x: 2000, y: 100, width: 980, height: 680 };
    expect(fitSavedBounds(b, [primary, second], primary)).toEqual(b);
  });

  it("drops the position of bounds on no display (so the window centers)", () => {
    // e.g. saved on a monitor that has since been unplugged
    const b = { x: 2000, y: 100, width: 980, height: 680 };
    expect(fitSavedBounds(b, [primary], primary)).toEqual({ width: 980, height: 680 });
  });

  it("clamps the size of off-screen bounds to the primary work area", () => {
    const b = { x: 5000, y: 100, width: 2500, height: 1400 };
    expect(fitSavedBounds(b, [primary], primary)).toEqual({ width: 1920, height: 1040 });
  });

  it("with no displays reported, treats bounds as off-screen", () => {
    const b = { x: 0, y: 0, width: 980, height: 680 };
    expect(fitSavedBounds(b, [], primary)).toEqual({ width: 980, height: 680 });
  });
});
