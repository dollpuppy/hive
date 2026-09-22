import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "../../src/shared/slug";

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Shady Penguinn!")).toBe("shady-penguinn");
  });
  it("strips diacritics", () => {
    expect(slugify("Pokémon Café")).toBe("pokemon-cafe");
  });
  it("collapses and trims dashes", () => {
    expect(slugify("  --Game__Capture--  ")).toBe("game-capture");
  });
  it("falls back when nothing is left", () => {
    expect(slugify("🎮🎮")).toBe("source");
  });
});

describe("uniqueSlug", () => {
  it("returns base when free", () => {
    expect(uniqueSlug("game", new Set())).toBe("game");
  });
  it("suffixes -2, -3 on collision", () => {
    expect(uniqueSlug("game", new Set(["game"]))).toBe("game-2");
    expect(uniqueSlug("game", new Set(["game", "game-2"]))).toBe("game-3");
  });
});
