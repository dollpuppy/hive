import { describe, expect, it } from "vitest";
import { containRect } from "../../src/web/alpha/contain-rect";

describe("containRect", () => {
  it("fits exactly when aspect matches", () => {
    expect(containRect(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });
  it("pillarboxes a square source", () => {
    expect(containRect(1000, 1000, 1280, 720)).toEqual({ x: 280, y: 0, w: 720, h: 720 });
  });
  it("letterboxes a wide source", () => {
    expect(containRect(2000, 500, 1280, 720)).toEqual({ x: 0, y: 200, w: 1280, h: 320 });
  });
  it("returns an empty rect for a zero-size source", () => {
    expect(containRect(0, 0, 1280, 720)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
