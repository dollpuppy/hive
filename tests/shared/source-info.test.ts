import { describe, expect, it } from "vitest";
import type { SourceConfig } from "../../src/main/config/config-store";
import { DEFAULT_ICE_SERVERS, iceServersFromTurn, sourceInfoFromConfig } from "../../src/shared/source-info";

describe("sourceInfoFromConfig", () => {
  it("uses preset size for captured sources", () => {
    const cfg: SourceConfig = { id: "a", name: "Game", slug: "game", preset: "med", kind: "window", windowTitle: "x" };
    expect(sourceInfoFromConfig(cfg, "idle")).toEqual({
      id: "a", name: "Game", slug: "game", kind: "window", alpha: false,
      width: 1920, height: 1080, fps: 30, status: "idle",
    });
  });
  it("marks spout as alpha", () => {
    const cfg: SourceConfig = { id: "v", name: "VT", slug: "vt", preset: "low", kind: "spout", senderName: "VSeeFace" };
    expect(sourceInfoFromConfig(cfg, "waiting")).toMatchObject({ alpha: true, width: 1280, height: 720, status: "waiting" });
  });
  it("uses configured size for url sources and preset fps", () => {
    const cfg: SourceConfig = {
      id: "u", name: "T", slug: "t", preset: "high", kind: "url", url: "http://localhost:3000/", width: 800, height: 600,
    };
    expect(sourceInfoFromConfig(cfg, "idle")).toMatchObject({ width: 800, height: 600, fps: 60, alpha: false });
  });
});

describe("iceServersFromTurn", () => {
  it("returns public STUN when no TURN is configured", () => {
    expect(iceServersFromTurn(null)).toEqual(DEFAULT_ICE_SERVERS);
  });
  it("appends TURN when configured", () => {
    expect(iceServersFromTurn({ url: "turn:t.example:3478", username: "u", credential: "p" })).toEqual([
      ...DEFAULT_ICE_SERVERS,
      { urls: "turn:t.example:3478", username: "u", credential: "p" },
    ]);
  });
  it("ignores a blank TURN url", () => {
    expect(iceServersFromTurn({ url: " ", username: "", credential: "" })).toEqual(DEFAULT_ICE_SERVERS);
  });
});
