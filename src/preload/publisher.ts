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
};

// One receiving pool for every shared-texture producer (Spout receivers and URL
// forwards). Producers tag frames with extraArgs [sourceId].
installSharedTextureReceiver();
const sinks = new Map<string, FrameSink>();
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
      console.error("[hive] frame sink threw", sourceId, err);
    }
  },
  onError: (err) => console.error("[hive] shared texture receive error", err),
});

const frames: HiveFramesApi = {
  register: (sourceId, sink) => {
    sinks.set(sourceId, sink);
    return () => {
      if (sinks.get(sourceId) === sink) sinks.delete(sourceId);
    };
  },
};

window.hivePublisher = api;
window.hiveFrames = frames;
