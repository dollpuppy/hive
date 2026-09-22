import type { IceServer, SignalPayload, SourceInfo, ViewerOutbound } from "../shared/protocol";
import { fromIcePayload, toIcePayload } from "./signal";

export interface ViewerClientOptions {
  url: string;
  peer: string;
  source: string;
  onStream(stream: MediaStream, source: SourceInfo): void;
  onIdle(): void;
  connectTimeoutMs?: number;
}

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;

export class ViewerClient {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private subId: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private delay = MIN_DELAY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly opts: ViewerClientOptions) {}

  start(): void {
    this.stopped = false;
    if (this.ws || this.retryTimer) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
  }

  private connect(): void {
    this.retryTimer = null;
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "watch", peer: this.opts.peer, source: this.opts.source }));
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: ViewerOutbound;
      try {
        msg = JSON.parse(String(ev.data)) as ViewerOutbound;
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.retry();
    };
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ViewerOutbound): void {
    switch (msg.type) {
      case "unavailable":
        this.retry();
        break;
      case "ended":
        if (msg.subId === this.subId) this.retry();
        break;
      case "watching":
        this.begin(msg.subId, msg.source, msg.iceServers);
        break;
      case "signal":
        if (msg.subId === this.subId) this.enqueue(msg.payload);
        break;
    }
  }

  private begin(subId: string, source: SourceInfo, iceServers: IceServer[]): void {
    // A second `watching` on the same socket should not happen; never leak the old session.
    this.closeSession();
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers });
    } catch {
      // Malformed ICE config (e.g. a bad user TURN URL). No connection was attempted, so this
      // is not an ICE failure; just go idle and retry.
      this.retry();
      return;
    }
    this.subId = subId;
    this.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate && this.pc === pc) this.send({ type: "signal", subId, payload: toIcePayload(e.candidate) });
    };
    pc.ontrack = (e) => {
      if (this.pc === pc) this.opts.onStream(e.streams[0] ?? new MediaStream([e.track]), source);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.delay = MIN_DELAY_MS;
      } else if (pc.connectionState === "failed") {
        this.iceFailed(pc, subId);
      }
    };
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (pc.connectionState !== "connected") this.iceFailed(pc, subId);
    }, this.opts.connectTimeoutMs ?? 10_000);
  }

  /** Report the failure once per session (retry() drops `this.pc`, so later calls are no-ops). */
  private iceFailed(pc: RTCPeerConnection, subId: string): void {
    if (this.pc !== pc) return;
    this.send({ type: "ice-failed", subId });
    this.retry();
  }

  private enqueue(payload: SignalPayload): void {
    const pc = this.pc;
    const subId = this.subId;
    if (!pc || !subId) return;
    this.queue = this.queue
      .then(async () => {
        if (this.pc !== pc) return;
        if (payload.kind === "sdp" && payload.type === "offer") {
          await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (this.pc !== pc) return;
          this.send({ type: "signal", subId, payload: { kind: "sdp", type: "answer", sdp: answer.sdp ?? "" } });
        } else if (payload.kind === "ice") {
          await pc.addIceCandidate(fromIcePayload(payload)).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  private retry(): void {
    this.teardown();
    this.opts.onIdle();
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
  }

  private closeSession(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.pc?.close();
    this.pc = null;
    this.subId = null;
    this.queue = Promise.resolve();
  }

  private teardown(): void {
    this.closeSession();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
