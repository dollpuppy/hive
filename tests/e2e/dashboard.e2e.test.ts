import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hub } from "../../src/main/hub/hub";
import { startLocalServer, type LocalServer } from "../../src/main/hub/local-server";
import { staticRoute } from "../../src/main/hub/static-files";
import type { DashboardState } from "../../src/shared/dashboard-api";

const baseState: DashboardState = {
  displayName: "Ana",
  port: 7421,
  server: { status: "stopped", inviteLink: null },
  join: { status: "idle", detail: null },
  partner: {
    name: "Shady Penguinn",
    slug: "shady-penguinn",
    sources: [{ id: "a", name: "Game", slug: "game", kind: "window", alpha: false, width: 1920, height: 1080, fps: 30, status: "live" }],
  },
  sources: [],
  watchers: {},
  spoutOut: [],
  spoutOutErrors: {},
  banners: [{ id: "port-fallback", message: "Port 7420 was busy, so Hive is using 7421." }],
  settings: { turn: null, keepSecret: false },
};

const mock = (state: DashboardState): string => `
  window.__calls = [];
  let st = ${JSON.stringify(state)};
  const listeners = [];
  const rec = (name) => (...args) => { window.__calls.push([name, ...args]); return Promise.resolve(); };
  window.hive = {
    getState: () => Promise.resolve(st),
    onState: (l) => listeners.push(l),
    startServer: rec("startServer"), stopServer: rec("stopServer"), join: rec("join"), leave: rec("leave"),
    kick: rec("kick"), addSource: rec("addSource"), updateSource: rec("updateSource"), removeSource: rec("removeSource"),
    retrySource: rec("retrySource"),
    setSpoutOut: rec("setSpoutOut"), updateSettings: rec("updateSettings"), dismissBanner: rec("dismissBanner"),
    listWindows: () => Promise.resolve([{ title: "melonDS", thumbnail: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }]),
    listSpoutSenders: () => Promise.resolve(["VSeeFace"]),
    copy: rec("copy"),
  };
  window.__push = (s) => { st = s; listeners.forEach((l) => l(s)); };
`;

let browser: Browser;
let server: LocalServer;

beforeAll(async () => {
  await build({ configFile: resolve(__dirname, "vite.dashboard.config.ts") });
  const hub = new Hub({ displayName: "T", getInviteSecret: () => null, getIceServers: () => [] });
  server = await startLocalServer({ hub, publisherToken: "T", ports: [0], httpRoutes: [staticRoute("/dash/", resolve(__dirname, ".dashboard-dist"))] });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(state: DashboardState = baseState): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript({ content: mock(state) });
  await page.goto(`http://127.0.0.1:${server.port}/dash/index.html`);
  await page.getByRole("button", { name: "Start Server" }).waitFor();
  return page;
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls);

describe("dashboard", () => {
  it("opens on the partner tab and copies a source URL", async () => {
    const page = await open();
    await expect(page.getByRole("tab", { name: /Shady Penguinn/ }).getAttribute("aria-selected")).resolves.toBe("true");
    await page.getByRole("button", { name: "Copy URL" }).click();
    expect(await calls(page)).toContainEqual(["copy", "http://localhost:7421/s/shady-penguinn/game"]);
    await expect(page.getByRole("button", { name: "Copied!" }).count()).resolves.toBe(1);
    await page.close();
  });

  it("shows banners and dismisses them", async () => {
    const page = await open();
    await page.getByText("Port 7420 was busy").waitFor();
    await page.getByRole("button", { name: "Dismiss" }).click();
    expect(await calls(page)).toContainEqual(["dismissBanner", "port-fallback"]);
    await page.close();
  });

  it("server button and invite reflect state", async () => {
    const page = await open();
    expect(await page.getByRole("button", { name: "Copy invite link" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Start Server" }).click();
    expect(await calls(page)).toContainEqual(["startServer"]);
    const up = { ...baseState, server: { status: "up", inviteLink: "https://a.trycloudflare.com/join#S" } };
    await page.evaluate((s) => (window as unknown as { __push: (x: unknown) => void }).__push(s), up);
    await page.getByRole("button", { name: "Stop Server" }).waitFor();
    await page.getByRole("button", { name: "Copy invite link" }).click();
    expect(await calls(page)).toContainEqual(["copy", "https://a.trycloudflare.com/join#S"]);
    await page.close();
  });

  it("typing in the invite box survives a state update, and Join sends it", async () => {
    const page = await open();
    const input = page.getByRole("textbox", { name: "Partner's invite link" });
    await input.click();
    await input.pressSequentially("https://b.trycloudflare.com/jo");
    await page.evaluate((s) => (window as unknown as { __push: (x: unknown) => void }).__push(s), { ...baseState, banners: [] });
    await input.pressSequentially("in#T");
    expect(await input.inputValue()).toBe("https://b.trycloudflare.com/join#T");
    await page.getByRole("button", { name: "Join" }).click();
    expect(await calls(page)).toContainEqual(["join", "https://b.trycloudflare.com/join#T"]);
    await page.close();
  });

  it("adds a browser URL source through the dialog", async () => {
    const page = await open();
    await page.getByRole("tab", { name: /My sources/ }).click();
    await page.getByRole("button", { name: "+ Add source" }).click();
    await page.getByRole("combobox", { name: "Type" }).selectOption("url");
    await page.locator("dialog input[type=text]").first().fill("Tracker");
    await page.getByRole("textbox", { name: "URL" }).fill("http://localhost:3000/");
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    expect(await calls(page)).toContainEqual([
      "addSource",
      { kind: "url", name: "Tracker", preset: "low", url: "http://localhost:3000/", width: 1280, height: 720 },
    ]);
    await page.close();
  });

  it("toggles Spout out for a partner source", async () => {
    const page = await open();
    await page.getByRole("checkbox", { name: "Spout out" }).check();
    expect(await calls(page)).toContainEqual(["setSpoutOut", "shady-penguinn", "game", true]);
    await page.close();
  });

  it("an unavailable local source shows Retry and calls retrySource", async () => {
    const state: DashboardState = {
      ...baseState,
      partner: null,
      sources: [
        {
          id: "src-1",
          name: "Game",
          slug: "game",
          kind: "window",
          windowTitle: "melonDS",
          preset: "low",
          status: "unavailable",
        },
      ],
    };
    const page = await open(state);
    await page.getByRole("button", { name: "Retry" }).click();
    expect(await calls(page)).toContainEqual(["retrySource", "src-1"]);
    await page.close();
  });
});
