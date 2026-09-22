import WebSocket from "ws";
import { MAX_MESSAGE_CHARS } from "../../shared/protocol";
import { parseInviteLink } from "../invite";
import type { Hub, Partner } from "./hub";
import { bindSocket, wsChannel } from "./local-server";

export type JoinStatus = "connecting" | "connected" | "reconnecting" | "failed" | "rejected" | "stopped";

export interface JoinOptions {
  hub: Hub;
  invite: string;
  retryWindowMs?: number;
  /** How long to wait for "welcome" after the socket opens before giving up on this attempt. */
  welcomeTimeoutMs?: number;
  onStatus: (status: JoinStatus, detail?: string) => void;
}

export interface JoinHandle {
  stop(): void;
}

const MAX_DELAY_MS = 10_000;

export function joinPartner(opts: JoinOptions): JoinHandle {
  const parsed = parseInviteLink(opts.invite);
  if (!parsed) {
    opts.onStatus("failed", "invalid-link");
    return { stop: () => undefined };
  }
  const { hub } = opts;
  if (hub.partner) {
    opts.onStatus("failed", "already-partnered");
    return { stop: () => undefined };
  }
  const windowMs = opts.retryWindowMs ?? 60_000;
  const welcomeTimeoutMs = opts.welcomeTimeoutMs ?? 10_000;
  let done = false;
  let everConnected = false;
  /** True once THIS attempt's link has produced a partner; scopes "partner"/"kicked" events to our own live socket. */
  let linked = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  let deadline = Date.now() + windowMs;
  /** Last retryable rejection reason (e.g. "full") seen this cycle; reported instead of "unreachable" if the window runs out. */
  let lastRejectReason: string | undefined;

  const clearWelcomeTimer = (): void => {
    if (welcomeTimer) clearTimeout(welcomeTimer);
    welcomeTimer = null;
  };

  const finish = (status: JoinStatus, detail?: string): void => {
    if (done) return;
    done = true;
    hub.off("partner", onPartner);
    hub.off("rejected", onRejected);
    hub.off("kicked", onKicked);
    if (timer) clearTimeout(timer);
    timer = null;
    clearWelcomeTimer();
    opts.onStatus(status, detail);
  };

  const onPartner = (partner: Partner | null): void => {
    if (done) return;
    if (partner) {
      // A stale link (not our current open socket) still finishing its handshake — ignore it.
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      linked = true;
      clearWelcomeTimer();
      everConnected = true;
      delay = 1000;
      lastRejectReason = undefined;
      opts.onStatus("connected");
    } else {
      if (!linked) return;
      linked = false;
      deadline = Date.now() + windowMs;
      // Force the half-open socket closed now instead of waiting on ws's own close handshake.
      socket?.terminate();
      opts.onStatus("reconnecting");
    }
  };
  const onRejected = (reason: string): void => {
    // A host that's "full" because our own last link with it hasn't timed out yet is worth
    // retrying — the slot frees up once that stale link's heartbeat lapses.
    if (everConnected && reason === "full") {
      lastRejectReason = reason;
      return;
    }
    finish("rejected", reason);
  };
  const onKicked = (): void => {
    if (!linked) return;
    finish("rejected", "kicked");
  };
  hub.on("partner", onPartner);
  hub.on("rejected", onRejected);
  hub.on("kicked", onKicked);

  const scheduleRetry = (): void => {
    if (done) return;
    if (Date.now() > deadline) {
      finish("failed", lastRejectReason ?? "unreachable");
      return;
    }
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  };

  const connect = (): void => {
    timer = null;
    if (done) return;
    opts.onStatus(everConnected ? "reconnecting" : "connecting");
    const ws = new WebSocket(parsed.hubUrl, { handshakeTimeout: 10_000, maxPayload: MAX_MESSAGE_CHARS });
    socket = ws;
    ws.on("open", () => {
      bindSocket(ws, hub.attachOutgoingPeer(wsChannel(ws), parsed.secret));
      clearWelcomeTimer();
      welcomeTimer = setTimeout(() => {
        if (socket === ws && !linked) ws.terminate();
      }, welcomeTimeoutMs);
    });
    ws.on("error", () => undefined);
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      // This runs before the Hub's own "partner" null event (registered later, on "open"), so
      // a clean disconnect from a link that was actually established must refresh the window
      // itself here — a long healthy session shouldn't count against the retry budget.
      if (linked) deadline = Date.now() + windowMs;
      linked = false;
      clearWelcomeTimer();
      if (everConnected && !done) opts.onStatus("reconnecting");
      scheduleRetry();
    });
  };

  connect();

  return {
    stop: () => {
      const ws = socket;
      socket = null;
      finish("stopped");
      ws?.close(1000, "leaving");
    },
  };
}
