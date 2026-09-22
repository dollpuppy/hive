import { ipcRenderer } from "electron";
import type { SourceConfig } from "../main/config/config-store";
import type { HivePublisherApi } from "../shared/publisher-api";

// contextIsolation is false for the Publisher window (required by texture-bridge
// in Plan 3), so the preload shares `window` with the page.
const api: HivePublisherApi = {
  getSources: () => ipcRenderer.invoke("hive:publisher:get-sources") as Promise<SourceConfig[]>,
  onSourcesChanged: (listener) => {
    ipcRenderer.on("hive:publisher:sources", (_e, sources: SourceConfig[]) => listener(sources));
  },
  selectWindow: (title) => ipcRenderer.invoke("hive:publisher:select-window", title) as Promise<void>,
};
window.hivePublisher = api;
