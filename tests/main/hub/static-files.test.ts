import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hub } from "../../../src/main/hub/hub";
import { startLocalServer, type LocalServer } from "../../../src/main/hub/local-server";
import { staticRoute, viewerRoute } from "../../../src/main/hub/static-files";

/** Sends a raw HTTP request that bypasses fetch/URL normalization, and returns the status code. */
function rawGetStatus(port: number, rawPath: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      match ? resolvePromise(Number(match[1])) : reject(new Error(`no status line: ${data}`));
    });
    socket.on("error", reject);
  });
}

let server: LocalServer;
let base: string;
let dir: string;
let secretFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-static-"));
  await writeFile(join(dir, "index.html"), "<html>viewer</html>");
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets", "main.js"), "console.log(1)");
  secretFile = join(tmpdir(), "hive-secret.txt");
  await writeFile(secretFile, "secret");
  const hub = new Hub({ displayName: "A", getInviteSecret: () => null, getIceServers: () => [] });
  server = await startLocalServer({
    hub,
    publisherToken: "T",
    ports: [0],
    httpRoutes: [viewerRoute(dir), staticRoute("/harness/", dir)],
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
  await rm(secretFile, { force: true });
});

describe("static files", () => {
  it("serves the viewer page for /s/<peer>/<source>", async () => {
    const res = await fetch(`${base}/s/ana/game?fit=cover`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("<html>viewer</html>");
  });
  it("404s malformed viewer paths", async () => {
    expect((await fetch(`${base}/s/ana`)).status).toBe(404);
    expect((await fetch(`${base}/s/ana/game/extra`)).status).toBe(404);
  });
  it("serves assets with content types", async () => {
    const res = await fetch(`${base}/viewer/assets/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });
  it("blocks path traversal", async () => {
    expect((await fetch(`${base}/viewer/..%2f..%2fhive-secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/viewer/%2e%2e/%2e%2e/hive-secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/viewer/..%5c..%5chive-secret.txt`)).status).toBe(404);
  });
  it("serves other prefixes via staticRoute", async () => {
    expect((await fetch(`${base}/harness/index.html`)).status).toBe(200);
  });
  it("never serves viewer pages through the tunnel", async () => {
    const res = await fetch(`${base}/s/ana/game`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(res.status).toBe(404);
  });
  it("never serves staticRoute prefixes through the tunnel", async () => {
    const res = await fetch(`${base}/harness/index.html`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(res.status).toBe(404);
  });
  it("blocks un-normalized traversal paths on the raw wire, bypassing fetch's own normalization", async () => {
    const paths = [
      "/viewer/%2e%2e/%2e%2e/hive-secret.txt",
      "/viewer/../../hive-secret.txt",
      "/viewer/C:%5cWindows%5cwin.ini",
      "/viewer/index.html%00.js",
    ];
    for (const path of paths) {
      expect(await rawGetStatus(server.port, path)).toBe(404);
    }
  });
});
