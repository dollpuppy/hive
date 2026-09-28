import type { IpcMainInvokeEvent } from "electron";
import type { BannerId, CapturableWindow, SettingsInput, SourceInput } from "../shared/dashboard-api";
import type { IpcHandleRegistry } from "./publisher-ipc";
import type { SessionController } from "./session/session-controller";

/** The SessionController methods the dashboard can reach (a fake in tests). */
export type DashboardSession = Pick<
  SessionController,
  | "state"
  | "startServer"
  | "stopServer"
  | "join"
  | "leave"
  | "kick"
  | "addSource"
  | "updateSource"
  | "removeSource"
  | "retrySource"
  | "setSpoutOut"
  | "updateSettings"
  | "dismissBanner"
  | "dismissInvite"
>;

export interface DashboardIpcDeps {
  ipcMain: IpcHandleRegistry;
  /** True when the invoke came from the dashboard's top-level frame. */
  isFromDashboard(event: IpcMainInvokeEvent): boolean;
  session: DashboardSession;
  listWindows(): Promise<CapturableWindow[]>;
  listSpoutSenders(): string[];
  copy(text: string): void;
}

const MAX_ID_CHARS = 256;
const MAX_SLUG_CHARS = 256;
const MAX_LINK_CHARS = 4096;
const MAX_COPY_CHARS = 16_384;

const BANNER_IDS: ReadonlySet<string> = new Set<BannerId>([
  "invite-changed",
  "upload-struggling",
  "p2p-failed",
  "port-fallback",
  "tunnel-failed",
  "spout-output-failed",
  "publisher-down",
]);

function requireString(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value === "" || value.length > max) throw new Error(`invalid ${what}`);
  return value;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid ${what}`);
  return value as Record<string, unknown>;
}

/**
 * Shape check only: SessionController does the real validation (trimming, schema parse,
 * URL scheme), but it assumes the fields it reads directly are strings.
 */
function requireSourceInput(value: unknown): SourceInput {
  const o = requireObject(value, "source");
  if (typeof o.kind !== "string" || typeof o.name !== "string") throw new Error("invalid source");
  return o as unknown as SourceInput;
}

function requireSettingsInput(value: unknown): SettingsInput {
  const o = requireObject(value, "settings");
  if (typeof o.displayName !== "string" || typeof o.keepSecret !== "boolean") throw new Error("invalid settings");
  if (o.turn !== null) {
    const t = requireObject(o.turn, "settings");
    if (typeof t.url !== "string" || typeof t.username !== "string" || typeof t.credential !== "string") {
      throw new Error("invalid settings");
    }
  }
  return o as unknown as SettingsInput;
}

/**
 * Registers the dashboard's `hive:dash:*` IPC. Every handler rejects callers other than the
 * dashboard's main frame and validates its primitive arguments; object inputs get a shape
 * check here and full validation in SessionController. A throw rejects the dashboard's invoke().
 */
export function registerDashboardIpc(deps: DashboardIpcDeps): void {
  const { session } = deps;
  const on = (name: string, fn: (...args: unknown[]) => unknown): void => {
    deps.ipcMain.handle(`hive:dash:${name}`, (event, ...args) => {
      if (!deps.isFromDashboard(event)) throw new Error("forbidden");
      return fn(...args);
    });
  };

  on("get-state", () => session.state());
  on("start-server", () => session.startServer());
  on("stop-server", () => session.stopServer());
  // The link is validated by the joiner (parseInviteLink -> "invalid-link" failure).
  on("join", (link) => session.join(requireString(link, "link", MAX_LINK_CHARS)));
  on("leave", () => session.leave());
  on("kick", () => session.kick());
  on("add-source", (input) => session.addSource(requireSourceInput(input)));
  on("update-source", (id, input) =>
    session.updateSource(requireString(id, "source id", MAX_ID_CHARS), requireSourceInput(input)),
  );
  on("remove-source", (id) => session.removeSource(requireString(id, "source id", MAX_ID_CHARS)));
  on("retry-source", (id) => session.retrySource(requireString(id, "source id", MAX_ID_CHARS)));
  on("set-spout-out", (partnerSlug, sourceSlug, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("invalid enabled flag");
    return session.setSpoutOut(
      requireString(partnerSlug, "partner slug", MAX_SLUG_CHARS),
      requireString(sourceSlug, "source slug", MAX_SLUG_CHARS),
      enabled,
    );
  });
  on("update-settings", (input) => session.updateSettings(requireSettingsInput(input)));
  on("dismiss-banner", (id) => {
    if (typeof id !== "string" || !BANNER_IDS.has(id)) throw new Error("invalid banner id");
    session.dismissBanner(id as BannerId);
  });
  on("dismiss-invite", () => session.dismissInvite());
  on("list-windows", () => deps.listWindows());
  on("list-spout-senders", () => deps.listSpoutSenders());
  on("copy", (text) => {
    if (typeof text !== "string" || text.length > MAX_COPY_CHARS) throw new Error("invalid text");
    deps.copy(text);
  });
}
