import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET, contentHintFor, encodingFor, PRESETS } from "../../src/shared/presets";

describe("presets", () => {
  it("matches the spec table", () => {
    expect(PRESETS).toEqual({
      low: { width: 1280, height: 720, fps: 30, maxBitrate: 2_500_000 },
      med: { width: 1920, height: 1080, fps: 30, maxBitrate: 5_000_000 },
      high: { width: 1920, height: 1080, fps: 60, maxBitrate: 8_000_000 },
    });
  });
  it("defaults per kind", () => {
    expect(DEFAULT_PRESET).toEqual({ window: "med", webcam: "low", spout: "low", url: "low" });
  });
  it("encodingFor applies the 1.6x alpha multiplier", () => {
    expect(encodingFor("low", false)).toEqual({ maxBitrate: 2_500_000, maxFramerate: 30 });
    expect(encodingFor("low", true)).toEqual({ maxBitrate: 4_000_000, maxFramerate: 30 });
  });
  it("content hints: detail for window/url, balanced otherwise", () => {
    expect(contentHintFor("window")).toBe("detail");
    expect(contentHintFor("url")).toBe("detail");
    expect(contentHintFor("webcam")).toBe("");
    expect(contentHintFor("spout")).toBe("");
  });
});
