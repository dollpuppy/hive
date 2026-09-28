import { describe, expect, it } from "vitest";
import { desiredOutputs, spoutOutputName } from "../../src/main/spout/spout-output-plan";
import type { Partner } from "../../src/main/hub/hub";

const partner: Partner = {
  name: "Shady Penguinn",
  slug: "shady-penguinn",
  sources: [
    { id: "a", name: "Game", slug: "game", kind: "window", alpha: false, width: 1920, height: 1080, fps: 30, status: "live" },
    { id: "b", name: "VTuber", slug: "vtuber", kind: "spout", alpha: true, width: 1280, height: 720, fps: 30, status: "waiting" },
  ],
};

describe("spout output plan", () => {
  it("names senders after partner and source", () => {
    expect(spoutOutputName("Shady Penguinn", "VTuber")).toBe("Hive - Shady Penguinn - VTuber");
  });

  it("wants enabled outputs for the current partner's existing sources", () => {
    const enabled = [
      { partnerSlug: "shady-penguinn", sourceSlug: "vtuber" },
      { partnerSlug: "shady-penguinn", sourceSlug: "gone" },
      { partnerSlug: "someone-else", sourceSlug: "game" },
    ];
    expect(desiredOutputs(partner, enabled)).toEqual([
      {
        key: "shady-penguinn/vtuber",
        name: "Hive - Shady Penguinn - VTuber",
        path: "/s/shady-penguinn/vtuber",
        width: 1280,
        height: 720,
        fps: 30,
      },
    ]);
  });

  it("wants nothing without a partner", () => {
    expect(desiredOutputs(null, [{ partnerSlug: "x", sourceSlug: "y" }])).toEqual([]);
  });

  it("dedupes duplicate enabled entries for the same source", () => {
    const enabled = [
      { partnerSlug: "shady-penguinn", sourceSlug: "vtuber" },
      { partnerSlug: "shady-penguinn", sourceSlug: "vtuber" },
    ];
    expect(desiredOutputs(partner, enabled)).toEqual([
      {
        key: "shady-penguinn/vtuber",
        name: "Hive - Shady Penguinn - VTuber",
        path: "/s/shady-penguinn/vtuber",
        width: 1280,
        height: 720,
        fps: 30,
      },
    ]);
  });

  it("truncates sender names longer than Spout's 256-byte (incl. NUL) limit", () => {
    const longPartner = "P".repeat(200);
    const longSource = "S".repeat(200);
    const name = spoutOutputName(longPartner, longSource);
    // 256-byte fixed buffer including a trailing NUL terminator.
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
  });

  it("never splits a surrogate pair when truncating", () => {
    // Prefix + "P - " is 11 bytes; the emoji (4 bytes, 2 UTF-16 units) starts at byte 252,
    // where a lone high surrogate (3 bytes as U+FFFD) would still "fit".
    const source = "S".repeat(255 - 11 - 3) + "😀";
    const name = spoutOutputName("P", source);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
    expect(name.endsWith("S")).toBe(true);
    expect(name).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
    // Exactly at the limit, the emoji is kept whole.
    const fits = spoutOutputName("P", "S".repeat(255 - 11 - 4) + "😀");
    expect(fits.endsWith("😀")).toBe(true);
    expect(Buffer.byteLength(fits, "utf8")).toBe(255);
  });

  it("numbers sources that share a display name, in source-list order", () => {
    const dup: Partner = {
      ...partner,
      sources: [
        { ...partner.sources[0]!, slug: "cam", name: "Cam" },
        { ...partner.sources[0]!, slug: "cam-2", name: "Cam" },
        { ...partner.sources[0]!, slug: "cam-3", name: "Cam" },
      ],
    };
    const enabled = ["cam-3", "cam", "cam-2"].map((sourceSlug) => ({ partnerSlug: "shady-penguinn", sourceSlug }));
    expect(desiredOutputs(dup, enabled).map((o) => [o.key, o.name])).toEqual([
      ["shady-penguinn/cam-3", "Hive - Shady Penguinn - Cam (3)"],
      ["shady-penguinn/cam", "Hive - Shady Penguinn - Cam"],
      ["shady-penguinn/cam-2", "Hive - Shady Penguinn - Cam (2)"],
    ]);
    // Only one enabled: its number doesn't change.
    expect(desiredOutputs(dup, [enabled[0]!])[0]?.name).toBe("Hive - Shady Penguinn - Cam (3)");
  });

  it("keeps the number when truncating a colliding long name", () => {
    const long = "L".repeat(300);
    const dup: Partner = {
      ...partner,
      sources: [
        { ...partner.sources[0]!, slug: "a", name: long },
        { ...partner.sources[0]!, slug: "b", name: long + "x" }, // differs only past the limit
      ],
    };
    const out = desiredOutputs(dup, [
      { partnerSlug: "shady-penguinn", sourceSlug: "a" },
      { partnerSlug: "shady-penguinn", sourceSlug: "b" },
    ]);
    expect(out[0]?.name).not.toBe(out[1]?.name);
    expect(out[1]?.name.endsWith(" (2)")).toBe(true);
    for (const o of out) expect(Buffer.byteLength(o.name, "utf8")).toBeLessThanOrEqual(255);
  });
});
