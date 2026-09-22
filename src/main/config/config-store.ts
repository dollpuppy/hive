import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const presetSchema = z.enum(["low", "med", "high"]);
export type Preset = z.infer<typeof presetSchema>;

const sourceBase = {
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  slug: z.string().min(1).max(80),
  preset: presetSchema,
};

export const sourceConfigSchema = z.discriminatedUnion("kind", [
  z.object({ ...sourceBase, kind: z.literal("window"), windowTitle: z.string() }),
  z.object({ ...sourceBase, kind: z.literal("webcam"), deviceId: z.string(), deviceLabel: z.string() }),
  z.object({ ...sourceBase, kind: z.literal("spout"), senderName: z.string() }),
  z.object({
    ...sourceBase,
    kind: z.literal("url"),
    url: z.string().url(),
    width: z.number().int().positive().max(3840),
    height: z.number().int().positive().max(2160),
  }),
]);
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const configSchema = z.object({
  version: z.literal(1),
  displayName: z.string().min(1).max(64),
  sources: z.array(sourceConfigSchema).max(16),
  turn: z.object({ url: z.string(), username: z.string(), credential: z.string() }).nullable(),
  keepSecret: z.boolean(),
  secret: z.string().nullable(),
  spoutOut: z.array(z.object({ partnerSlug: z.string(), sourceSlug: z.string() })),
  windowBounds: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable(),
});
export type HiveConfig = z.infer<typeof configSchema>;

export function defaultConfig(): HiveConfig {
  return {
    version: 1,
    displayName: "Streamer",
    sources: [],
    turn: null,
    keepSecret: false,
    secret: null,
    spoutOut: [],
    windowBounds: null,
  };
}

async function backupCorrupt(file: string): Promise<void> {
  await rename(file, `${file}.corrupt-${Date.now()}`);
}

export async function loadConfig(file: string): Promise<HiveConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    await backupCorrupt(file);
    return defaultConfig();
  }
  const merged =
    typeof data === "object" && data !== null && !Array.isArray(data) ? { ...defaultConfig(), ...data } : data;
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    await backupCorrupt(file);
    return defaultConfig();
  }
  return result.data;
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!RETRYABLE_RENAME_CODES.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await sleep(delay);
    }
  }
  await rename(from, to);
}

export async function saveConfig(file: string, config: HiveConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
