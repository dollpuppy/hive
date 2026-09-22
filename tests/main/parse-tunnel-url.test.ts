import { describe, expect, it } from "vitest";
import { parseTunnelUrl } from "../../src/main/tunnel/parse-tunnel-url";

describe("parseTunnelUrl", () => {
  it("finds the url in the cloudflared banner", () => {
    const out = [
      "2026-09-21T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-09-21T10:00:01Z INF |  https://calm-river-1234.trycloudflare.com                       |",
    ].join("\n");
    expect(parseTunnelUrl(out)).toBe("https://calm-river-1234.trycloudflare.com");
  });
  it("ignores api.trycloudflare.com", () => {
    expect(parseTunnelUrl("POST https://api.trycloudflare.com/tunnel failed")).toBeNull();
  });
  it("returns null when absent", () => {
    expect(parseTunnelUrl("INF Starting tunnel")).toBeNull();
  });
});
