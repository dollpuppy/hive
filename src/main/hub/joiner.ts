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
  const windowMs = opts.retryWindowMs ?? 60_000;
  const { hub } = opts;
  let done = false;
  let everConnected = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;
  let deadline = Date.now() + windowMs;

  const finish = (status: JoinStatus, detail?: string): void => {
    if (done) return;
    done = true;
    hub.off("partner", onPartner);
    hub.off("rejected", onRejected);
    hub.off("kicked", onKicked);
    if (timer) clearTimeout(timer);
    timer = null;
    opts.onStatus(status, detail);
  };

  const onPartner = (partner: Partner | null): void => {
    if (done) return;
    if (partner) {
      everConnected = true;
      delay = 1000;
      opts.onStatus("connected");
    } else {
      deadline = Date.now() + windowMs;
    }
  };
  const onRejected = (reason: string): void => finish("rejected", reason);
  const onKicked = (): void => finish("rejected", "kicked");
  hub.on("partner", onPartner);
  hub.on("rejected", onRejected);
  hub.on("kicked", onKicked);

  const scheduleRetry = (): void => {
    if (done) return;
    if (Date.now() > deadline) {
      finish("failed", "unreachable");
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
    ws.on("open", () => bindSocket(ws, hub.attachOutgoingPeer(wsChannel(ws), parsed.secret)));
    ws.on("error", () => undefined);
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
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
