import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig, type HiveConfig } from "../../src/main/config/config-store";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-config-"));
  file = join(dir, "nested", "config.json");
});

describe("config store", () => {
  it("returns defaults when the file is missing", async () => {
    expect(await loadConfig(file)).toEqual(defaultConfig());
  });

  it("round-trips a saved config", async () => {
    const cfg: HiveConfig = {
      ...defaultConfig(),
      displayName: "Ana",
      sources: [
        { id: "a", name: "Game", slug: "game", preset: "med", kind: "window", windowTitle: "melonDS" },
        { id: "b", name: "Cam", slug: "cam", preset: "low", kind: "webcam", deviceId: "d1", deviceLabel: "C920" },
        { id: "c", name: "VTuber", slug: "vtuber", preset: "low", kind: "spout", senderName: "VSeeFace" },
        { id: "d", name: "Tracker", slug: "tracker", preset: "low", kind: "url", url: "http://localhost:3000/", width: 800, height: 600 },
      ],
      turn: { url: "turn:turn.example.com:3478", username: "u", credential: "p" },
      spoutOut: [{ partnerSlug: "ana", sourceSlug: "game" }],
    };
    await saveConfig(file, cfg);
    expect(await loadConfig(file)).toEqual(cfg);
  });

  it("fills missing keys from defaults", async () => {
    await saveConfig(file, defaultConfig());
    await writeFile(file, JSON.stringify({ version: 1, displayName: "Bo" }));
    expect(await loadConfig(file)).toEqual({ ...defaultConfig(), displayName: "Bo" });
  });

  it("backs up and resets a corrupt file", async () => {
    await saveConfig(file, defaultConfig());
    await writeFile(file, "{corrupt");
    expect(await loadConfig(file)).toEqual(defaultConfig());
    const files = await readdir(join(dir, "nested"));
    expect(files.some((f) => f.startsWith("config.json.corrupt-"))).toBe(true);
  });

  it("backs up and resets a schema-invalid file", async () => {
    await saveConfig(file, defaultConfig());
    await writeFile(file, JSON.stringify({ version: 1, displayName: 42 }));
    expect(await loadConfig(file)).toEqual(defaultConfig());
  });

  it("writes pretty JSON", async () => {
    await saveConfig(file, defaultConfig());
    expect(await readFile(file, "utf8")).toContain('\n  "version": 1');
  });
});
