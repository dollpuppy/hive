import { contextBridge, ipcRenderer } from "electron";
import type { DashboardApi, DashboardState } from "../shared/dashboard-api";

// Runs sandboxed: only `electron` may be imported at runtime (everything else is type-only).

const invoke = <T = void>(name: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`hive:dash:${name}`, ...args) as Promise<T>;

const api: DashboardApi = {
  getState: () => invoke<DashboardState>("get-state"),
  onState: (listener) => {
    ipcRenderer.on("hive:dash:state", (_e, state: DashboardState) => listener(state));
  },
  startServer: () => invoke("start-server"),
  stopServer: () => invoke("stop-server"),
  join: (link) => invoke("join", link),
  leave: () => invoke("leave"),
  kick: () => invoke("kick"),
  addSource: (input) => invoke("add-source", input),
  updateSource: (id, input) => invoke("update-source", id, input),
  removeSource: (id) => invoke("remove-source", id),
  retrySource: (id) => invoke("retry-source", id),
  setSpoutOut: (partnerSlug, sourceSlug, enabled) => invoke("set-spout-out", partnerSlug, sourceSlug, enabled),
  updateSettings: (input) => invoke("update-settings", input),
  dismissBanner: (id) => invoke("dismiss-banner", id),
  listWindows: () => invoke("list-windows"),
  listSpoutSenders: () => invoke("list-spout-senders"),
  copy: (text) => invoke("copy", text),
};

contextBridge.exposeInMainWorld("hive", api);
