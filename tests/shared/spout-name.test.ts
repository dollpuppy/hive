import { describe, expect, it } from "vitest";
import { spoutOutputName, spoutOutputNames, truncateUtf8 } from "../../src/shared/spout-name";

describe("spoutOutputName", () => {
  it("names senders after partner and source", () => {
    expect(spoutOutputName("Shady Penguinn", "VTuber")).toBe("Hive - Shady Penguinn - VTuber");
  });

  it("appends a whole suffix", () => {
    expect(spoutOutputName("P", "S", " (2)")).toBe("Hive - P - S (2)");
  });
});

describe("truncateUtf8", () => {
  it("leaves short strings untouched", () => {
    expect(truncateUtf8("hello", 100)).toBe("hello");
  });

  it("never splits a surrogate pair", () => {
    const value = "a".repeat(3) + "😀"; // emoji is 4 bytes / 2 UTF-16 units
    // Truncating to 4 bytes would land inside the emoji; it must be dropped whole.
    expect(truncateUtf8(value, 4)).toBe("aaa");
  });
});

describe("spoutOutputNames", () => {
  it("gives each source its plain sender name when there's no collision", () => {
    const names = spoutOutputNames("Partner", [
      { slug: "game", name: "Game" },
      { slug: "vtuber", name: "VTuber" },
    ]);
    expect(names.get("game")).toBe("Hive - Partner - Game");
    expect(names.get("vtuber")).toBe("Hive - Partner - VTuber");
  });

  it("numbers sources that share a display name, in list order", () => {
    const names = spoutOutputNames("Partner", [
      { slug: "cam", name: "Cam" },
      { slug: "cam-2", name: "Cam" },
      { slug: "cam-3", name: "Cam" },
    ]);
    expect(names.get("cam")).toBe("Hive - Partner - Cam");
    expect(names.get("cam-2")).toBe("Hive - Partner - Cam (2)");
    expect(names.get("cam-3")).toBe("Hive - Partner - Cam (3)");
  });

  it("ignores a duplicate slug (keeps the first)", () => {
    const names = spoutOutputNames("Partner", [
      { slug: "a", name: "First" },
      { slug: "a", name: "Second" },
    ]);
    expect(names.get("a")).toBe("Hive - Partner - First");
    expect(names.size).toBe(1);
  });
});
