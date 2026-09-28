import { ipcRenderer, type IpcRendererEvent } from "electron";
import { consumeSharedTexture, installSharedTextureReceiver } from "@napolab/texture-bridge-renderer/client";
import type { SourceConfig } from "../main/config/config-store";
import type { FrameSink, HiveFramesApi, HivePublisherApi } from "../shared/publisher-api";

// contextIsolation is false for the Publisher window (required by texture-bridge
// in Plan 3), so the preload shares `window` with the page.
const api: HivePublisherApi = {
  getSources: () => ipcRenderer.invoke("hive:publisher:get-sources") as Promise<SourceConfig[]>,
  onSourcesChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, sources: SourceConfig[]): void => listener(sources);
    ipcRenderer.on("hive:publisher:sources", handler);
    return () => {
      ipcRenderer.removeListener("hive:publisher:sources", handler);
    };
  },
  selectWindow: (title) => ipcRenderer.invoke("hive:publisher:select-window", title) as Promise<void>,
  spoutOpen: (sourceId, senderName) =>
    ipcRenderer.invoke("hive:publisher:spout-open", sourceId, senderName) as Promise<number>,
  spoutClose: (sourceId, handle) =>
    ipcRenderer.invoke("hive:publisher:spout-close", sourceId, handle) as Promise<void>,
  spoutSenders: () => ipcRenderer.invoke("hive:publisher:spout-senders") as Promise<string[]>,
  onSpoutAvailability: (listener) => {
    const handler = (_e: IpcRendererEvent, name: string, available: boolean): void => listener(name, available);
    ipcRenderer.on("hive:publisher:spout-availability", handler);
    return () => {
      ipcRenderer.removeListener("hive:publisher:spout-availability", handler);
    };
  },
  urlOpen: (sourceId) => ipcRenderer.invoke("hive:publisher:url-open", sourceId) as Promise<number>,
  urlClose: (sourceId, handle) => ipcRenderer.invoke("hive:publisher:url-close", sourceId, handle) as Promise<void>,
  onUrlFailed: (listener) => {
    const handler = (_e: IpcRendererEvent, sourceId: string, handle: number): void => listener(sourceId, handle);
    ipcRenderer.on("hive:publisher:url-failed", handler);
    return () => {
      ipcRenderer.removeListener("hive:publisher:url-failed", handler);
    };
  },
};

// One receiving pool for every shared-texture producer (Spout receivers and URL
// forwards). Producers tag frames with extraArgs [sourceId].
installSharedTextureReceiver();
const sinks = new Map<string, FrameSink>();
/** A throwing sink throws per frame: log at most this often per source. */
const SINK_ERROR_LOG_INTERVAL_MS = 5000;
const sinkErrorLog = new Map<string, { last: number; suppressed: number }>();
function logSinkError(sourceId: string, err: unknown): void {
  const now = Date.now();
  const log = sinkErrorLog.get(sourceId) ?? { last: -Infinity, suppressed: 0 };
  sinkErrorLog.set(sourceId, log);
  if (now - log.last < SINK_ERROR_LOG_INTERVAL_MS) {
    log.suppressed += 1;
    return;
  }
  const note = log.suppressed > 0 ? ` (${log.suppressed} similar errors suppressed)` : "";
  log.last = now;
  log.suppressed = 0;
  console.error(`[hive] frame sink threw${note}`, sourceId, err);
}
consumeSharedTexture({
  onFrame: (frame, ...args) => {
    const sourceId = args[0];
    if (typeof sourceId !== "string") return;
    // Unregistered (disconnected) sources drop in-flight frames here instead of resurrecting.
    const sink = sinks.get(sourceId);
    if (!sink) return;
    try {
      sink(frame.videoFrame);
    } catch (err) {
      logSinkError(sourceId, err);
    }
  },
  onError: (err) => console.error("[hive] shared texture receive error", err),
});

const frames: HiveFramesApi = {
  register: (sourceId, sink) => {
    sinks.set(sourceId, sink);
    return () => {
      if (sinks.get(sourceId) !== sink) return;
      sinks.delete(sourceId);
      sinkErrorLog.delete(sourceId);
    };
  },
};

window.hivePublisher = api;
window.hiveFrames = frames;
