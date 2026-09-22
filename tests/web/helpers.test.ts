import { describe, expect, it } from "vitest";
import { preferCodecs } from "../../src/web/codecs";
import { fromIcePayload, toIcePayload } from "../../src/web/signal";
import { StruggleTracker } from "../../src/web/struggle-tracker";

describe("signal conversion", () => {
  it("round-trips an ICE candidate", () => {
    const payload = toIcePayload({ candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 });
    expect(payload).toEqual({ kind: "ice", candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0 });
    expect(fromIcePayload(payload)).toEqual({ candidate: payload.candidate, sdpMid: "0", sdpMLineIndex: 0 });
  });
  it("normalizes undefined mid/index to null", () => {
    expect(toIcePayload({ candidate: "c" })).toEqual({ kind: "ice", candidate: "c", sdpMid: null, sdpMLineIndex: null });
  });
});

describe("preferCodecs", () => {
  it("puts H264 first, then VP8, keeping the rest in order", () => {
    const codecs = [
      { mimeType: "video/VP9", clockRate: 90000 },
      { mimeType: "video/rtx", clockRate: 90000 },
      { mimeType: "video/VP8", clockRate: 90000 },
      { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f" },
      { mimeType: "video/AV1", clockRate: 90000 },
    ];
    expect(preferCodecs(codecs).map((c) => c.mimeType)).toEqual([
      "video/H264", "video/VP8", "video/VP9", "video/rtx", "video/AV1",
    ]);
  });
});

describe("StruggleTracker", () => {
  it("reports struggling after >5s of bandwidth limitation and recovery immediately", () => {
    const t = new StruggleTracker(5000);
    expect(t.sample(true, 0)).toBeNull();
    expect(t.sample(true, 4000)).toBeNull();
    expect(t.sample(true, 6000)).toBe(true);
    expect(t.sample(true, 8000)).toBeNull();
    expect(t.sample(false, 10000)).toBe(false);
    expect(t.sample(false, 12000)).toBeNull();
  });
  it("a single unlimited sample resets the window", () => {
    const t = new StruggleTracker(5000);
    t.sample(true, 0);
    t.sample(false, 3000);
    expect(t.sample(true, 6000)).toBeNull();
    expect(t.sample(true, 11_500)).toBe(true);
  });
});
