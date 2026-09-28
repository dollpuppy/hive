import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2026.9.1";
const SOURCE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "resources", "cloudflared.exe");
const lockFile = join(root, "scripts", "cloudflared.lock.json");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const lock = existsSync(lockFile) ? JSON.parse(await readFile(lockFile, "utf8")) : null;
if (existsSync(out) && lock?.version === VERSION && sha256(await readFile(out)) === lock.sha256) {
  console.log(`cloudflared ${VERSION} already present`);
  process.exit(0);
}

console.log(`Downloading ${SOURCE}`);
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const hash = sha256(buf);
if (lock?.version === VERSION && lock.sha256 !== hash) {
  throw new Error(`cloudflared hash mismatch: expected ${lock.sha256}, got ${hash}`);
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
if (lock?.version !== VERSION) {
  await writeFile(lockFile, `${JSON.stringify({ version: VERSION, sha256: hash }, null, 2)}\n`);
  console.log(`Pinned sha256 ${hash} in scripts/cloudflared.lock.json — commit this file.`);
}
console.log(`cloudflared ${VERSION} -> resources/cloudflared.exe`);
