import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  isWatchable,
  parseMessage,
  peerMessageSchema,
  publisherInboundSchema,
  viewerInboundSchema,
  PROTOCOL_VERSION,
  PUBLISHER_REPLACED_CLOSE_CODE,
  type IceServer,
  type PeerMessage,
  type PublisherOutbound,
  type RejectReason,
  type SignalPayload,
  type SourceInfo,
  type SourceStatus,
  type ViewerOutbound,
} from "../../shared/protocol";
import { slugify, uniqueSlug } from "../../shared/slug";
import { secretsEqual } from "../invite";
import type { Channel, ChannelHandler } from "./channel";

/** Viewer URL peer segment that refers to this Hub's own sources (dashboard previews). */
export const SELF_SLUG = "me";

/**
 * "rejected" reasons this Hub can emit locally, beyond the wire-protocol `RejectReason` enum.
 * "already-partnered" fires when a second outgoing link welcomes in while we already have a
 * partner — a local race, not something the remote host told us — so it must stay distinct
 * from a remote "full" rejection (which is retryable; see joiner.ts).
 */
export type LocalRejectReason = RejectReason | "already-partnered";

export interface Partner {
  name: string;
  slug: string;
  sources: SourceInfo[];
}

export interface HubOptions {
  displayName: string;
  /** Current invite secret, or null when not hosting (all hellos rejected). */
  getInviteSecret: () => string | null;
  getIceServers: () => IceServer[];
  heartbeatMs?: number;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
}

interface PeerLink {
  channel: Channel;
  role: "host" | "joiner";
  established: boolean;
  closed: boolean;
  lastSeen: number;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * One active WebRTC subscription.
 * - viewer: the local viewer channel, or null when the partner is the viewer.
 * - target: who publishes the media — our own Publisher or the partner.
 */
interface Sub {
  sourceId: string;
  viewer: Channel | null;
  target: "publisher" | "partner";
}

type EndOrigin = "viewer" | "publisher" | "partner" | "hub";

export class Hub extends EventEmitter {
  private localSources: SourceInfo[] = [];
  private partnerState: Partner | null = null;
  private peer: PeerLink | null = null;
  private publisher: Channel | null = null;
  private readonly subs = new Map<string, Sub>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: HubOptions) {
    super();
  }

  get partner(): Partner | null {
    return this.partnerState;
  }

  get sources(): SourceInfo[] {
    return this.localSources;
  }

  get hasPublisher(): boolean {
    return this.publisher !== null;
  }

  // ---------------------------------------------------------------- sources

  setLocalSources(sources: SourceInfo[]): void {
    this.localSources = sources;
    for (const [subId, sub] of [...this.subs]) {
      if (sub.target !== "publisher") continue;
      const s = sources.find((x) => x.id === sub.sourceId);
      if (!s || !isWatchable(s.status)) this.endSub(subId, "hub");
    }
    this.sendPeer({ type: "sources", sources });
    this.emit("local-sources", sources);
  }

  private setSourceStatus(sourceId: string, status: SourceStatus): void {
    const current = this.localSources.find((s) => s.id === sourceId);
    if (!current || current.status === status) return;
    this.setLocalSources(this.localSources.map((s) => (s.id === sourceId ? { ...s, status } : s)));
  }

  // ------------------------------------------------------------------- peer

  attachIncomingPeer(channel: Channel): ChannelHandler {
    const link: PeerLink = {
      channel,
      role: "host",
      established: false,
      closed: false,
      lastSeen: Date.now(),
      handshakeTimer: null,
    };
    const handshakeTimeoutMs = this.opts.handshakeTimeoutMs ?? 10_000;
    link.handshakeTimer = setTimeout(() => {
      if (link.established || link.closed) return;
      link.closed = true;
      link.channel.close(1008, "handshake timeout");
    }, handshakeTimeoutMs);
    return this.peerHandler(link);
  }

  attachOutgoingPeer(channel: Channel, secret: string): ChannelHandler {
    const link: PeerLink = {
      channel,
      role: "joiner",
      established: false,
      closed: false,
      lastSeen: Date.now(),
      handshakeTimer: null,
    };
    channel.send({
      type: "hello",
      secret,
      peerName: this.opts.displayName,
      protocolVersion: PROTOCOL_VERSION,
    });
    return this.peerHandler(link);
  }

  kick(reason = "removed by partner"): void {
    const link = this.peer;
    if (!link) return;
    link.channel.send({ type: "kick", reason });
    this.emit("kicked-partner");
    link.channel.close(1000, "kicked");
    this.onPeerClose(link);
  }

  dispose(): void {
    this.stopHeartbeat();
    if (this.peer) {
      const link = this.peer;
      link.channel.close(1001, "shutting down");
      this.onPeerClose(link);
    }
  }

  private peerHandler(link: PeerLink): ChannelHandler {
    return {
      onMessage: (raw) => this.onPeerMessage(link, raw),
      onClose: () => this.onPeerClose(link),
    };
  }

  private onPeerMessage(link: PeerLink, raw: string): void {
    if (link.closed) return;
    const msg = parseMessage(peerMessageSchema, raw);
    if (!msg) return;
    link.lastSeen = Date.now();
    if (!link.established) {
      this.onHandshake(link, msg);
      return;
    }
    if (this.peer !== link) return;
    switch (msg.type) {
      case "sources":
        this.onPartnerSources(msg.sources);
        break;
      case "subscribe":
        this.onPartnerSubscribe(msg.subId, msg.sourceId);
        break;
      case "unsubscribe": {
        const sub = this.subs.get(msg.subId);
        if (sub && (sub.target === "partner" || sub.viewer === null)) this.endSub(msg.subId, "partner");
        break;
      }
      case "signal":
        this.onPartnerSignal(msg.subId, msg.payload);
        break;
      case "kick":
        this.emit("kicked", msg.reason);
        link.channel.close(1000, "kicked");
        this.onPeerClose(link);
        break;
      case "ping":
        link.channel.send({ type: "pong" });
        break;
      default:
        break;
    }
  }

  private onHandshake(link: PeerLink, msg: PeerMessage): void {
    if (link.role === "host") {
      if (msg.type !== "hello") {
        link.closed = true;
        this.clearHandshakeTimer(link);
        link.channel.close(1008, "expected hello");
        return;
      }
      if (msg.protocolVersion !== PROTOCOL_VERSION) return this.reject(link, "version");
      const secret = this.opts.getInviteSecret();
      if (secret === null || !secretsEqual(secret, msg.secret)) return this.reject(link, "bad-secret");
      if (this.peer) return this.reject(link, "full");
      link.channel.send({
        type: "welcome",
        peerName: this.opts.displayName,
        protocolVersion: PROTOCOL_VERSION,
      });
      this.establish(link, msg.peerName);
      return;
    }
    if (msg.type === "reject") {
      this.emit("rejected", msg.reason);
      link.closed = true;
      link.channel.close(1000, "rejected");
      return;
    }
    if (msg.type !== "welcome") return;
    if (this.peer && this.peer !== link) {
      this.emit("rejected", "already-partnered" satisfies LocalRejectReason);
      link.closed = true;
      link.channel.close(1000, "already partnered");
      return;
    }
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.emit("rejected", "version" satisfies RejectReason);
      link.closed = true;
      link.channel.close(1000, "version");
      return;
    }
    this.establish(link, msg.peerName);
  }

  private reject(link: PeerLink, reason: RejectReason): void {
    link.channel.send({ type: "reject", reason });
    link.closed = true;
    this.clearHandshakeTimer(link);
    link.channel.close(1008, reason);
  }

  private establish(link: PeerLink, name: string): void {
    this.clearHandshakeTimer(link);
    link.established = true;
    this.peer = link;
    this.partnerState = { name, slug: uniqueSlug(slugify(name), new Set([SELF_SLUG])), sources: [] };
    link.channel.send({ type: "sources", sources: this.localSources });
    this.startHeartbeat();
    this.emit("partner", this.partnerState);
  }

  private clearHandshakeTimer(link: PeerLink): void {
    if (link.handshakeTimer) {
      clearTimeout(link.handshakeTimer);
      link.handshakeTimer = null;
    }
  }

  private onPeerClose(link: PeerLink): void {
    link.closed = true;
    this.clearHandshakeTimer(link);
    if (this.peer !== link) return;
    this.peer = null;
    this.partnerState = null;
    this.stopHeartbeat();
    for (const [subId, sub] of [...this.subs]) {
      if (sub.target === "partner" || sub.viewer === null) this.endSub(subId, "partner");
    }
    this.emit("partner", null);
  }

  private sendPeer(msg: PeerMessage): void {
    if (this.peer?.established) this.peer.channel.send(msg);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const every = this.opts.heartbeatMs ?? 10_000;
    const timeout = this.opts.timeoutMs ?? 30_000;
    this.heartbeat = setInterval(() => {
      const link = this.peer;
      if (!link) return;
      if (Date.now() - link.lastSeen > timeout) {
        link.channel.close(4000, "timeout");
        this.onPeerClose(link);
        return;
      }
      link.channel.send({ type: "ping" });
    }, every);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private onPartnerSources(sources: SourceInfo[]): void {
    if (!this.partnerState) return;
    const changed = JSON.stringify(this.partnerState.sources) !== JSON.stringify(sources);
    this.partnerState = { ...this.partnerState, sources };
    for (const [subId, sub] of [...this.subs]) {
      if (sub.target !== "partner") continue;
      const s = sources.find((x) => x.id === sub.sourceId);
      if (!s || !isWatchable(s.status)) this.endSub(subId, "partner");
    }
    if (changed) this.emit("partner", this.partnerState);
  }

  private onPartnerSubscribe(subId: string, sourceId: string): void {
    const s = this.localSources.find((x) => x.id === sourceId);
    if (!s || !isWatchable(s.status) || !this.publisher || this.subs.has(subId)) {
      this.sendPeer({ type: "unsubscribe", subId });
      return;
    }
    this.subs.set(subId, { sourceId, viewer: null, target: "publisher" });
    this.sendPublisher({ type: "subscribe", subId, sourceId, iceServers: this.opts.getIceServers() });
  }

  private onPartnerSignal(subId: string, payload: SignalPayload): void {
    const sub = this.subs.get(subId);
    if (!sub) return;
    if (sub.viewer && sub.target === "partner") {
      this.sendViewer(sub.viewer, { type: "signal", subId, payload });
    } else if (!sub.viewer && sub.target === "publisher") {
      this.sendPublisher({ type: "signal", subId, payload });
    }
  }

  // ----------------------------------------------------------------- viewer

  attachViewer(channel: Channel): ChannelHandler {
    const mine = new Set<string>();
    return {
      onMessage: (raw) => {
        const msg = parseMessage(viewerInboundSchema, raw);
        if (!msg) return;
        if (msg.type === "watch") {
          const subId = this.watch(channel, msg.peer, msg.source);
          if (subId) mine.add(subId);
          return;
        }
        const sub = this.subs.get(msg.subId);
        if (!sub || sub.viewer !== channel) return;
        if (msg.type === "ice-failed") {
          this.emit("p2p-failed", { subId: msg.subId, sourceId: sub.sourceId });
          return;
        }
        if (sub.target === "publisher") {
          this.sendPublisher({ type: "signal", subId: msg.subId, payload: msg.payload });
        } else {
          this.sendPeer({ type: "signal", subId: msg.subId, payload: msg.payload });
        }
      },
      onClose: () => {
        for (const subId of mine) this.endSub(subId, "viewer");
        mine.clear();
      },
    };
  }

  private watch(channel: Channel, peerSlug: string, sourceSlug: string): string | null {
    let found: SourceInfo | undefined;
    let target: Sub["target"] = "partner";
    if (peerSlug === SELF_SLUG) {
      target = "publisher";
      found = this.publisher ? this.localSources.find((s) => s.slug === sourceSlug) : undefined;
    } else if (this.partnerState && this.partnerState.slug === peerSlug) {
      found = this.partnerState.sources.find((s) => s.slug === sourceSlug);
    }
    if (!found || !isWatchable(found.status)) {
      this.sendViewer(channel, { type: "unavailable" });
      return null;
    }
    const subId = randomUUID();
    this.subs.set(subId, { sourceId: found.id, viewer: channel, target });
    this.sendViewer(channel, {
      type: "watching",
      subId,
      source: found,
      iceServers: this.opts.getIceServers(),
    });
    if (target === "publisher") {
      this.sendPublisher({ type: "subscribe", subId, sourceId: found.id, iceServers: this.opts.getIceServers() });
    } else {
      this.sendPeer({ type: "subscribe", subId, sourceId: found.id });
    }
    return subId;
  }

  private sendViewer(channel: Channel, msg: ViewerOutbound): void {
    channel.send(msg);
  }

  // -------------------------------------------------------------- publisher

  attachPublisher(channel: Channel): ChannelHandler {
    if (this.publisher && this.publisher !== channel) {
      const old = this.publisher;
      for (const [subId, sub] of [...this.subs]) {
        if (sub.target === "publisher") this.endSub(subId, "publisher");
      }
      old.close(PUBLISHER_REPLACED_CLOSE_CODE, "replaced");
    }
    this.publisher = channel;
    return {
      onMessage: (raw) => {
        if (this.publisher !== channel) return;
        const msg = parseMessage(publisherInboundSchema, raw);
        if (!msg) return;
        switch (msg.type) {
          case "signal": {
            const sub = this.subs.get(msg.subId);
            if (!sub || sub.target !== "publisher") return;
            if (sub.viewer) this.sendViewer(sub.viewer, { type: "signal", subId: msg.subId, payload: msg.payload });
            else this.sendPeer({ type: "signal", subId: msg.subId, payload: msg.payload });
            break;
          }
          case "unsubscribe":
            this.endSub(msg.subId, "publisher");
            break;
          case "source-status":
            this.setSourceStatus(msg.sourceId, msg.status);
            break;
          case "health":
            this.emit("health", msg.struggling);
            break;
        }
      },
      onClose: () => {
        if (this.publisher !== channel) return;
        this.publisher = null;
        for (const [subId, sub] of [...this.subs]) {
          if (sub.target === "publisher") this.endSub(subId, "publisher");
        }
      },
    };
  }

  private sendPublisher(msg: PublisherOutbound): void {
    this.publisher?.send(msg);
  }

  // ------------------------------------------------------------------- subs

  private endSub(subId: string, origin: EndOrigin): void {
    const sub = this.subs.get(subId);
    if (!sub) return;
    this.subs.delete(subId);
    if (sub.viewer && origin !== "viewer") this.sendViewer(sub.viewer, { type: "ended", subId });
    if (sub.target === "publisher" && origin !== "publisher") this.sendPublisher({ type: "unsubscribe", subId });
    const partnerInvolved = sub.target === "partner" || sub.viewer === null;
    if (partnerInvolved && origin !== "partner") this.sendPeer({ type: "unsubscribe", subId });
  }
}
