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
});
