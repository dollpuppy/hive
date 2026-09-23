import { describe, expect, it } from "vitest";
import type { SourceConfig } from "../../src/main/config/config-store";
import { SpoutNames, applySpoutAvailability } from "../../src/renderer/publisher/spout-names";

const spout = (id: string, senderName: string): SourceConfig => ({
  id,
  name: id,
  slug: id,
  preset: "low",
  kind: "spout",
  senderName,
});
const cam: SourceConfig = { id: "c1", name: "Cam", slug: "cam", preset: "low", kind: "webcam", deviceId: "d", deviceLabel: "Cam" };

function collect(sources: SourceConfig[], names: SpoutNames): [string, boolean][] {
  const out: [string, boolean][] = [];
  applySpoutAvailability(sources, names, (id, a) => out.push([id, a]));
  return out;
}

describe("SpoutNames", () => {
  it("merges the snapshot", () => {
    const n = new SpoutNames();
    n.loadSnapshot(["A", "B"]);
    expect(n.has("A")).toBe(true);
    expect(n.has("B")).toBe(true);
  });

  it("events during the fetch win over the snapshot", () => {
    const n = new SpoutNames();
    n.update("A", false);
    n.update("C", true);
    n.loadSnapshot(["A", "B"]);
    expect(n.has("A")).toBe(false);
    expect(n.has("B")).toBe(true);
    expect(n.has("C")).toBe(true);
  });

  it("events after the fetch apply normally", () => {
    const n = new SpoutNames();
    n.loadSnapshot([]);
    n.update("A", true);
    expect(n.has("A")).toBe(true);
    n.update("A", false);
    expect(n.has("A")).toBe(false);
  });

  it("a failed fetch stops tracking touched names", () => {
    const n = new SpoutNames();
    n.update("A", true);
    n.endFetch();
    expect(n.has("A")).toBe(true);
  });
});

describe("applySpoutAvailability", () => {
  it("reports only Spout sources", () => {
    const n = new SpoutNames();
    n.loadSnapshot(["OBS"]);
    expect(collect([spout("s1", "OBS"), spout("s2", "Gone"), cam], n)).toEqual([
      ["s1", true],
      ["s2", false],
    ]);
  });

  it("a sources push during the fetch is corrected by re-applying after the snapshot", () => {
    const n = new SpoutNames();
    const sources = [spout("s1", "OBS")];
    // Pushed while spoutSenders() is still in flight: the name set is still empty.
    expect(collect(sources, n)).toEqual([["s1", false]]);
    n.loadSnapshot(["OBS"]);
    expect(collect(sources, n)).toEqual([["s1", true]]);
  });
});
