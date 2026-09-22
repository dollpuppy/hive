import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hub } from "../../src/main/hub/hub";
import { joinPartner } from "../../src/main/hub/joiner";
import { startLocalServer, type LocalServer } from "../../src/main/hub/local-server";
import { staticRoute, viewerRoute } from "../../src/main/hub/static-files";

const root = resolve(__dirname, "../..");
const DEBUG = process.env.HIVE_E2E_DEBUG === "1";
let browser: Browser;
let hostServer: LocalServer;
let joinServer: LocalServer;
let hostHub: Hub;
let joinHub: Hub;
let stopJoin: () => void;

async function until(pred: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function newPage(label: string): Promise<Page> {
  const page = await browser.newPage();
  if (DEBUG) {
    page.on("console", (m) => console.log(`[${label}] ${m.text()}`));
    page.on("pageerror", (e) => console.log(`[${label}] pageerror ${e.message}`));
  }
  return page;
}

/** Open a harness page and wait until the host Hub has attached *its* publisher socket. */
async function openPublisher(label = "publisher", setup?: (page: Page) => void, ms = 15_000): Promise<Page> {
  let onPublisher: ((up: boolean) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attached = new Promise<void>((resolveAttached, rejectAttached) => {
    onPublisher = (up: boolean): void => {
      if (up) resolveAttached();
    };
    hostHub.on("publisher", onPublisher);
    timer = setTimeout(() => rejectAttached(new Error(`${label}: publisher did not attach within ${ms} ms`)), ms);
  });
  // Don't surface an unhandled rejection if goto() throws first.
  attached.catch(() => undefined);
  try {
    const page = await newPage(label);
    setup?.(page);
    await page.goto(`http://127.0.0.1:${hostServer.port}/harness/index.html?token=HT`);
    await attached;
    // The Hub marks sources unavailable while no Publisher is connected; wait for this one's report.
    await until(() => hostHub.sources[0]?.status === "idle", ms);
    return page;
  } finally {
    clearTimeout(timer);
    if (onPublisher) hostHub.off("publisher", onPublisher);
  }
}

type HarnessWindow = { harness: { refs: () => number; acquired: () => string[] } };

const refs = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as HarnessWindow).harness.refs());

const acquired = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as HarnessWindow).harness.acquired());

const refsDropToZero = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => (window as unknown as HarnessWindow).harness.refs() === 0, undefined, { timeout: 10_000 });

beforeAll(async () => {
  await build({ configFile: resolve(root, "vite.viewer.config.ts"), logLevel: "warn" });
  await build({ configFile: resolve(root, "tests/e2e/vite.harness.config.ts") });

  const viewerDir = resolve(root, "out/viewer");
  hostHub = new Hub({ displayName: "Ana", getInviteSecret: () => "S", getIceServers: () => [] });
  joinHub = new Hub({ displayName: "Bo", getInviteSecret: () => null, getIceServers: () => [] });
  hostServer = await startLocalServer({
    hub: hostHub,
    publisherToken: "HT",
    ports: [0],
    httpRoutes: [viewerRoute(viewerDir), staticRoute("/harness/", resolve(root, "tests/e2e/.harness-dist"))],
  });
  joinServer = await startLocalServer({ hub: joinHub, publisherToken: "JT", ports: [0], httpRoutes: [viewerRoute(viewerDir)] });

  hostHub.setLocalSources([
    { id: "src-game", name: "Game", slug: "game", kind: "window", alpha: false, width: 640, height: 360, fps: 30, status: "idle" },
  ]);
  const join = joinPartner({ hub: joinHub, invite: `http://127.0.0.1:${hostServer.port}/join#S`, onStatus: () => undefined });
  stopJoin = join.stop;
  await until(() => (joinHub.partner?.sources.length ?? 0) === 1);

  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});

afterEach(async () => {
  // Keep tests independent: every page is closed, so wait for the host to drop the publisher socket.
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) await page.close();
  }
  if (hostHub) await until(() => !hostHub.hasPublisher, 5_000);
});

afterAll(async () => {
  await browser?.close();
  stopJoin?.();
  joinHub?.dispose();
  hostHub?.dispose();
  await hostServer?.close();
  await joinServer?.close();
});

describe("media e2e", () => {
  it("partner's viewer page plays the published source, and closing it stops publishing", async () => {
    const publisher = await openPublisher();

    const viewer = await newPage("viewer");
    await viewer.goto(`http://127.0.0.1:${joinServer.port}/s/ana/game`);
    await viewer.waitForFunction(
      () => {
        const v = document.getElementById("stage") as HTMLVideoElement;
        return !v.hidden && v.videoWidth === 640 && v.currentTime > 0.5;
      },
      undefined,
      { timeout: 20_000 },
    );
    expect(await refs(publisher)).toBe(1);
    expect(await acquired(publisher)).toEqual(["src-game"]);

    await viewer.close();
    await refsDropToZero(publisher);
  });

  it("local 'me' preview plays on the host", async () => {
    const publisher = await openPublisher();
    const viewer = await newPage("viewer");
    await viewer.goto(`http://127.0.0.1:${hostServer.port}/s/me/game`);
    await viewer.waitForFunction(
      () => {
        const v = document.getElementById("stage") as HTMLVideoElement;
        return !v.hidden && v.videoWidth === 640 && v.currentTime > 0.5;
      },
      undefined,
      { timeout: 20_000 },
    );
    expect(await refs(publisher)).toBe(1);
    expect(await acquired(publisher)).toEqual(["src-game"]);

    await viewer.close();
    await refsDropToZero(publisher);
  });

  it("viewer stays hidden (transparent) for an unknown source and keeps retrying", async () => {
    let watches = 0;
    const viewer = await newPage("viewer");
    viewer.on("websocket", (ws) => {
      if (ws.url().endsWith("/local/viewer")) watches++;
    });
    await viewer.goto(`http://127.0.0.1:${joinServer.port}/s/ana/nothing`);
    // First attempt immediately, the retry after ~1 s.
    await until(() => watches >= 2, 5_000);
    expect(await viewer.evaluate(() => (document.getElementById("stage") as HTMLVideoElement).hidden)).toBe(true);
  });

  it("a replaced publisher (close code 4001) does not reconnect and evict its successor", async () => {
    let attaches = 0;
    const count = (up: boolean): void => {
      if (up) attaches++;
    };
    let firstSockets = 0;
    let firstClosed = 0;
    const first = await openPublisher("publisher-1", (page) =>
      page.on("websocket", (ws) => {
        if (!ws.url().includes("/local/publisher")) return;
        firstSockets++;
        ws.on("close", () => firstClosed++);
      }),
    );
    await until(() => firstSockets === 1, 5_000);

    hostHub.on("publisher", count);
    try {
      const second = await openPublisher("publisher-2");
      await until(() => firstClosed === 1, 5_000);
      const baseline = attaches;
      // The old client's reconnect delay is 1 s; give it well over that to (wrongly) come back.
      await new Promise((r) => setTimeout(r, 2500));
      expect(attaches).toBe(baseline);
      expect(firstSockets).toBe(1);
      expect(hostHub.hasPublisher).toBe(true);

      // The surviving publisher is the second page: a preview subscription lands there.
      const viewer = await newPage("viewer");
      await viewer.goto(`http://127.0.0.1:${hostServer.port}/s/me/game`);
      await viewer.waitForFunction(
        () => (document.getElementById("stage") as HTMLVideoElement).videoWidth === 640,
        undefined,
        { timeout: 20_000 },
      );
      expect(await refs(second)).toBe(1);
      expect(await acquired(second)).toEqual(["src-game"]);
      expect(await refs(first)).toBe(0);
    } finally {
      hostHub.off("publisher", count);
    }
  });
});
