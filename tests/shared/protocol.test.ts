import { describe, expect, it } from "vitest";
import {
  isWatchable,
  parseMessage,
  peerMessageSchema,
  publisherInboundSchema,
  viewerInboundSchema,
  type SourceInfo,
} from "../../src/shared/protocol";

const source: SourceInfo = {
  id: "s1", name: "Game", slug: "game", kind: "window", alpha: false,
  width: 1920, height: 1080, fps: 30, status: "idle",
};

describe("parseMessage", () => {
  it("parses a valid hello", () => {
    const raw = JSON.stringify({ type: "hello", secret: "abc", peerName: "Ana", protocolVersion: 1 });
    expect(parseMessage(peerMessageSchema, raw)).toEqual({
      type: "hello", secret: "abc", peerName: "Ana", protocolVersion: 1,
    });
  });
  it("parses sources", () => {
    const raw = JSON.stringify({ type: "sources", sources: [source] });
    expect(parseMessage(peerMessageSchema, raw)).toEqual({ type: "sources", sources: [source] });
  });
  it("parses sdp and ice signals", () => {
    const sdp = { type: "signal", subId: "x", payload: { kind: "sdp", type: "offer", sdp: "v=0" } };
    const ice = {
      type: "signal", subId: "x",
      payload: { kind: "ice", candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    };
    expect(parseMessage(peerMessageSchema, JSON.stringify(sdp))).toEqual(sdp);
    expect(parseMessage(peerMessageSchema, JSON.stringify(ice))).toEqual(ice);
  });
  it("returns null for invalid JSON", () => {
    expect(parseMessage(peerMessageSchema, "{nope")).toBeNull();
  });
  it("returns null for unknown type", () => {
    expect(parseMessage(peerMessageSchema, JSON.stringify({ type: "evil" }))).toBeNull();
  });
  it("returns null for oversized input", () => {
    expect(parseMessage(peerMessageSchema, "x".repeat(300_000))).toBeNull();
  });
  it("parses viewer watch", () => {
    const raw = JSON.stringify({ type: "watch", peer: "ana", source: "game" });
    expect(parseMessage(viewerInboundSchema, raw)).toEqual({ type: "watch", peer: "ana", source: "game" });
  });
  it("parses publisher source-status", () => {
    const raw = JSON.stringify({ type: "source-status", sourceId: "s1", status: "live" });
    expect(parseMessage(publisherInboundSchema, raw)).toEqual({
      type: "source-status", sourceId: "s1", status: "live",
    });
  });
});

describe("isWatchable", () => {
  it("accepts live and idle only", () => {
    expect(isWatchable("live")).toBe(true);
    expect(isWatchable("idle")).toBe(true);
    expect(isWatchable("waiting")).toBe(false);
    expect(isWatchable("unavailable")).toBe(false);
  });
});
