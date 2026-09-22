import type { EncodingParams } from "../shared/presets";
import {
  PUBLISHER_REPLACED_CLOSE_CODE,
  type IceServer,
  type PublisherOutbound,
  type SignalPayload,
  type SourceStatus,
} from "../shared/protocol";
import { preferCodecs } from "./codecs";
import { fromIcePayload, toIcePayload } from "./signal";
import { StruggleTracker } from "./struggle-tracker";

export interface PublisherClientOptions {
  url: string;
  acquire(sourceId: string): Promise<MediaStream>;
  release(sourceId: string): void;
  encodingFor(sourceId: string): EncodingParams | null;
}

class PublisherSession {
  readonly pc: RTCPeerConnection;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly subId: string,
    private readonly stream: MediaStream,
    private readonly encoding: EncodingParams,
    iceServers: IceServer[],
    private readonly send: (msg: object) => void,
    onFailed: () => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: "signal", subId, payload: toIcePayload(e.candidate) });
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "failed") onFailed();
    };
  }

  async start(): Promise<void> {
    const track = this.stream.getVideoTracks()[0];
    if (!track) throw new Error("stream has no video track");
    const transceiver = this.pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [this.stream],
      sendEncodings: [{ maxBitrate: this.encoding.maxBitrate, maxFramerate: this.encoding.maxFramerate }],
    });
    const caps = RTCRtpSender.getCapabilities("video");
    if (caps) transceiver.setCodecPreferences(preferCodecs(caps.codecs));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.send({ type: "signal", subId: this.subId, payload: { kind: "sdp", type: "offer", sdp: offer.sdp ?? "" } });
  }

  onSignal(payload: SignalPayload): void {
    this.queue = this.queue
      .then(async () => {
        if (payload.kind === "sdp" && payload.type === "answer") {
          await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        } else if (payload.kind === "ice") {
          await this.pc.addIceCandidate(fromIcePayload(payload)).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  async bandwidthLimited(): Promise<boolean> {
    const stats = await this.pc.getStats();
    for (const report of stats.values()) {
      if (report.type === "outbound-rtp" && report.kind === "video" && report.qualityLimitationReason === "bandwidth") {
        return true;
      }
    }
    return false;
  }

  close(): void {
    this.pc.close();
  }
}

interface Entry {
  sourceId: string;
  session: PublisherSession | null;
  cancelled: boolean;
}

export class PublisherClient {
  private ws: WebSocket | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly tracker = new StruggleTracker(5000);
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly lastStatus = new Map<string, SourceStatus>();
  /** Mirrors the tracker's state so it can be re-sent after a reconnect. */
  private struggling = false;
  private sampling = false;

  constructor(private readonly opts: PublisherClientOptions) {}

  start(): void {
    if (this.healthTimer) return;
    this.stopped = false;
    this.connect();
    this.healthTimer = setInterval(() => void this.sampleHealth(), 2000);
  }

  stop(): void {
    this.halt();
    this.ws?.close();
    this.ws = null;
  }

  reportStatus(sourceId: string, status: SourceStatus): void {
    this.lastStatus.set(sourceId, status);
    this.send({ type: "source-status", sourceId, status });
  }

  /** The source died (window closed, webcam unplugged): end all its sessions. */
  endSource(sourceId: string): void {
    for (const [subId, entry] of [...this.entries]) {
      if (entry.sourceId === sourceId) this.end(subId, true);
    }
  }

  /** Stop timers and end every session; the socket is left to the caller. */
  private halt(): void {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const subId of [...this.entries.keys()]) this.end(subId, false);
  }

  private connect(): void {
    this.reconnectTimer = null;
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      for (const [sourceId, status] of this.lastStatus) this.send({ type: "source-status", sourceId, status });
      this.send({ type: "health", struggling: this.struggling });
    };
    ws.onmessage = (ev) => {
      let msg: PublisherOutbound;
      try {
        msg = JSON.parse(String(ev.data)) as PublisherOutbound;
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === PUBLISHER_REPLACED_CLOSE_CODE) {
        // Another publisher window took over; reconnecting would just evict it in turn.
        this.halt();
        return;
      }
      for (const subId of [...this.entries.keys()]) this.end(subId, false);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    };
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: PublisherOutbound): void {
    switch (msg.type) {
      case "subscribe":
        void this.onSubscribe(msg.subId, msg.sourceId, msg.iceServers);
        break;
      case "unsubscribe":
        this.end(msg.subId, false);
        break;
      case "signal":
        this.entries.get(msg.subId)?.session?.onSignal(msg.payload);
        break;
    }
  }

  private async onSubscribe(subId: string, sourceId: string, iceServers: IceServer[]): Promise<void> {
    if (this.entries.has(subId)) return;
    const encoding = this.opts.encodingFor(sourceId);
    if (!encoding) {
      this.send({ type: "unsubscribe", subId });
      return;
    }
    const entry: Entry = { sourceId, session: null, cancelled: false };
    this.entries.set(subId, entry);
    let stream: MediaStream;
    try {
      stream = await this.opts.acquire(sourceId);
    } catch {
      if (!entry.cancelled) {
        this.entries.delete(subId);
        this.send({ type: "unsubscribe", subId });
      }
      return;
    }
    if (entry.cancelled) {
      this.opts.release(sourceId);
      return;
    }
    const isCurrent = (): boolean => this.entries.get(subId) === entry;
    try {
      entry.session = new PublisherSession(subId, stream, encoding, iceServers, (m) => this.send(m), () => {
        if (isCurrent()) this.end(subId, true);
      });
      await entry.session.start();
    } catch {
      // Construction (e.g. a malformed TURN URL) or offer creation failed. If the entry was
      // already ended meanwhile, end() closed the session and released the stream.
      if (!isCurrent()) return;
      this.entries.delete(subId);
      entry.session?.close();
      this.opts.release(sourceId);
      this.send({ type: "unsubscribe", subId });
    }
  }

  private end(subId: string, notifyHub: boolean): void {
    const entry = this.entries.get(subId);
    if (!entry) return;
    this.entries.delete(subId);
    if (entry.session) {
      entry.session.close();
      this.opts.release(entry.sourceId);
    } else {
      entry.cancelled = true;
    }
    if (notifyHub) this.send({ type: "unsubscribe", subId });
  }

  private async sampleHealth(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const sessions = [...this.entries.values()].flatMap((e) => (e.session ? [e.session] : []));
      let limited = false;
      for (const s of sessions) {
        if (await s.bandwidthLimited().catch(() => false)) limited = true;
      }
      const change = this.tracker.sample(limited, Date.now());
      if (change !== null) {
        this.struggling = change;
        this.send({ type: "health", struggling: change });
      }
    } finally {
      this.sampling = false;
    }
  }
}
