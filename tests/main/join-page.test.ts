import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inviteFromArgv } from "../../src/main/deep-link";
import { Hub } from "../../src/main/hub/hub";
import { joinRoute } from "../../src/main/hub/join-page";
import { startLocalServer, type LocalServer } from "../../src/main/hub/local-server";

let server: LocalServer;
beforeAll(async () => {
  const hub = new Hub({ displayName: "A", getInviteSecret: () => null, getIceServers: () => [] });
  server = await startLocalServer({ hub, publisherToken: "T", ports: [0], httpRoutes: [joinRoute()] });
});
afterAll(async () => {
  await server.close();
});

describe("join page", () => {
  it("is reachable through the tunnel with safe headers", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/join`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("hive://join?link=");
    expect(html).toContain("Open in Hive");
  });
});

describe("inviteFromArgv", () => {
  it("extracts the invite from a hive:// argument", () => {
    const invite = "https://a.trycloudflare.com/join#S3cret";
    const argv = ["C:\\Hive\\Hive.exe", `hive://join?link=${encodeURIComponent(invite)}`];
    expect(inviteFromArgv(argv)).toBe(invite);
  });
  it("returns null without one", () => {
    expect(inviteFromArgv(["Hive.exe", "--profile=a"])).toBeNull();
    expect(inviteFromArgv(["Hive.exe", "hive://join"])).toBeNull();
  });
  it("requires the hive://join host", () => {
    const link = encodeURIComponent("https://a.trycloudflare.com/join#S");
    expect(inviteFromArgv(["Hive.exe", `hive://other?link=${link}`])).toBeNull();
    expect(inviteFromArgv(["Hive.exe", `hive://?link=${link}`])).toBeNull();
    expect(inviteFromArgv(["Hive.exe", `hive://JOIN/?link=${link}`])).toBe("https://a.trycloudflare.com/join#S");
  });
});
