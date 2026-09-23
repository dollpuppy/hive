import type { IpcMainInvokeEvent } from "electron";
import type { SourceConfig } from "./config/config-store";
import { PRESETS } from "../shared/presets";

/** The slice of `ipcMain` used here (a fake in tests). */
export interface IpcHandleRegistry {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
}

export interface PublisherIpcDeps {
  ipcMain: IpcHandleRegistry;
  /** True when the invoke came from the Publisher's top-level frame. */
  isFromPublisher(event: IpcMainInvokeEvent): boolean;
  /** The current configured sources (read on every call, so config changes apply). */
  sources(): readonly SourceConfig[];
  spout: {
    senders(): string[];
    open(sourceId: string, senderName: string): number;
    close(sourceId: string, handle?: number): void;
  };
  url: {
    open(sourceId: string, url: string, width: number, height: number, fps: number): number;
    close(sourceId: string, handle?: number): void;
  };
}

const MAX_ID_CHARS = 256;
const MAX_SENDER_CHARS = 256;

function requireString(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value === "" || value.length > max) throw new Error(`invalid ${what}`);
  return value;
}

function requireHandle(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("invalid handle");
  return value;
}

/**
 * Registers the Publisher's Spout and URL-source IPC. Every handler rejects callers
 * other than the Publisher's main frame and validates its arguments. The renderer
 * only names configured sources by id: main resolves the URL (and checks the sender
 * name) from config, so the Publisher can't make main load arbitrary URLs or
 * receive arbitrary Spout senders.
 *
 * Opens and closes run synchronously (no `await` before them), so they apply in
 * the order the Publisher sent them. A throw rejects the Publisher's invoke(),
 * which is how e.g. a missing sender is reported.
 */
export function registerPublisherIpc(deps: PublisherIpcDeps): void {
  const { ipcMain } = deps;
  const guard = (event: IpcMainInvokeEvent): void => {
    if (!deps.isFromPublisher(event)) throw new Error("forbidden");
  };

  ipcMain.handle("hive:publisher:spout-senders", (event) => {
    guard(event);
    return deps.spout.senders();
  });

  ipcMain.handle("hive:publisher:spout-open", (event, sourceId, senderName) => {
    guard(event);
    const id = requireString(sourceId, "sourceId", MAX_ID_CHARS);
    const name = requireString(senderName, "sender name", MAX_SENDER_CHARS);
    const s = deps.sources().find((x) => x.id === id && x.kind === "spout");
    if (!s || s.kind !== "spout" || s.senderName !== name) throw new Error(`unknown spout source ${id}`);
    return deps.spout.open(id, name);
  });

  ipcMain.handle("hive:publisher:spout-close", (event, sourceId, handle) => {
    guard(event);
    deps.spout.close(requireString(sourceId, "sourceId", MAX_ID_CHARS), requireHandle(handle));
  });

  ipcMain.handle("hive:publisher:url-open", (event, sourceId) => {
    guard(event);
    const id = requireString(sourceId, "sourceId", MAX_ID_CHARS);
    const s = deps.sources().find((x) => x.id === id);
    if (!s || s.kind !== "url") throw new Error(`unknown url source ${id}`);
    return deps.url.open(s.id, s.url, s.width, s.height, PRESETS[s.preset].fps);
  });

  ipcMain.handle("hive:publisher:url-close", (event, sourceId, handle) => {
    guard(event);
    deps.url.close(requireString(sourceId, "sourceId", MAX_ID_CHARS), requireHandle(handle));
  });
}

/** Where main pushes events to the Publisher (its webContents; a fake in tests). */
export interface PublisherEventTarget {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface PublisherEventDeps {
  /** The Publisher's webContents, or null once its window is gone. */
  target(): PublisherEventTarget | null;
  spout: { on(event: "availability", listener: (senderName: string, available: boolean) => void): unknown };
  url: { on(event: "failed", listener: (sourceId: string, handle: number, reason: string) => void): unknown };
}

/**
 * Pushes Spout sender availability and URL-source give-ups to the Publisher, dropping
 * them while its webContents is missing or destroyed. A give-up carries the open's
 * handle so the Publisher only ends the capture that open belongs to.
 */
export function forwardPublisherEvents(deps: PublisherEventDeps): void {
  const send = (channel: string, ...args: unknown[]): void => {
    const target = deps.target();
    if (target && !target.isDestroyed()) target.send(channel, ...args);
  };
  deps.spout.on("availability", (name, available) => send("hive:publisher:spout-availability", name, available));
  deps.url.on("failed", (sourceId, handle) => send("hive:publisher:url-failed", sourceId, handle));
}
