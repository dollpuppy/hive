import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hub } from "../../src/main/hub/hub";
import { startLocalServer, type LocalServer } from "../../src/main/hub/local-server";
import { staticRoute } from "../../src/main/hub/static-files";

type Px = [number, number, number, number];
let browser: Browser;
let server: LocalServer;

beforeAll(async () => {
  await build({ configFile: resolve(__dirname, "vite.alpha.config.ts") });
  const hub = new Hub({ displayName: "T", getInviteSecret: () => null, getIceServers: () => [] });
  server = await startLocalServer({ hub, publisherToken: "T", ports: [0], httpRoutes: [staticRoute("/alpha/", resolve(__dirname, ".alpha-dist"))] });
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

function expectNear(actual: Px, expected: Px, tolerance: number): void {
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `channel ${i}: got ${actual} want ${expected}`).toBeLessThanOrEqual(tolerance));
}

describe("alpha packing", () => {
  it("round-trips without encoding (exact-ish)", async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/alpha/index.html`);
    const px = (await page.evaluate(() => (window as any).alphaTest.direct())) as Record<string, Px>;
    expectNear(px.tl!, [255, 0, 0, 255], 3);
    expectNear(px.tr!, [0, 128, 0, 128], 3);
    expectNear(px.bl!, [0, 0, 255, 255], 3);
    expectNear(px.br!, [0, 0, 0, 0], 3);
    await page.close();
  });

  it("survives WebRTC encoding within tolerance", async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/alpha/index.html`);
    const px = (await page.evaluate(() => (window as any).alphaTest.throughWebRtc())) as Record<string, Px>;
    expectNear(px.tl!, [255, 0, 0, 255], 24);
    expectNear(px.tr!, [0, 128, 0, 128], 24);
    expectNear(px.bl!, [0, 0, 255, 255], 24);
    expectNear(px.br!, [0, 0, 0, 0], 24);
    await page.close();
  });

  it("letterboxes a narrower source with transparent pillarbox bars", async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/alpha/index.html`);
    const px = (await page.evaluate(() => (window as any).alphaTest.pillarbox())) as Record<string, Px>;
    expectNear(px.centre!, [255, 0, 0, 255], 3);
    expectNear(px.left!, [0, 0, 0, 0], 3);
    expectNear(px.right!, [0, 0, 0, 0], 3);
    await page.close();
  });
});
