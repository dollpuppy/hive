import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import type { ServerResponse } from "node:http";
import type { HttpRoute } from "./local-server";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function sendFile(res: ServerResponse, root: string, relative: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return false;
  }
  const rootAbs = resolve(root);
  const file = resolve(rootAbs, decoded);
  if (file !== rootAbs && !file.startsWith(rootAbs + sep)) return false;
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  // pipeline (not stream.pipe) ensures the read fd is closed on client abort or a mid-stream error.
  pipeline(createReadStream(file), res, () => undefined);
  return true;
}

/** Serves files under `dir` at URL prefix (e.g. "/viewer/"). Local-only (tunnel requests never reach routes except /join;
 *  the viaTunnel check here is defense in depth in case a route is ever wired up differently).
 *  Owns its prefix outright: any request under `prefix` that doesn't resolve to a file is answered
 *  with 404 here, not left to fall through to a later route. */
export function staticRoute(prefix: string, dir: string): HttpRoute {
  return (req, res, ctx) => {
    if (ctx.viaTunnel) return false;
    if (req.method !== "GET" || !ctx.path.startsWith(prefix)) return false;
    // ctx.path is normalized by URL parsing, but req.url is the raw wire text — only trust the
    // slice if the raw text also starts with the prefix, otherwise a mismatch (e.g. an
    // unnormalized `..` segment) could smuggle bytes past the prefix cut.
    const rawPath = (req.url ?? "").split("?")[0]!;
    if (!rawPath.startsWith(prefix)) {
      res.writeHead(404).end();
      return true;
    }
    const relative = rawPath.slice(prefix.length);
    if (sendFile(res, dir, relative)) return true;
    res.writeHead(404).end();
    return true;
  };
}

const VIEWER_PAGE = /^\/s\/[^/]+\/[^/]+$/;

/** `/s/<peer>/<source>` -> viewer index.html; `/viewer/*` -> viewer assets. */
export function viewerRoute(viewerDir: string): HttpRoute {
  const assets = staticRoute("/viewer/", viewerDir);
  return (req, res, ctx) => {
    if (ctx.viaTunnel) return false;
    if (req.method === "GET" && VIEWER_PAGE.test(ctx.path)) {
      if (!sendFile(res, viewerDir, "index.html")) res.writeHead(404).end();
      return true;
    }
    return assets(req, res, ctx);
  };
}
