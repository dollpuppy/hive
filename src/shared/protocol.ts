import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_CHARS = 256 * 1024;
/** WebSocket close code sent to a publisher superseded by a newer one; it must not reconnect. */
export const PUBLISHER_REPLACED_CLOSE_CODE = 4001;

export const sourceKindSchema = z.enum(["window", "webcam", "spout", "url"]);
export const sourceStatusSchema = z.enum(["live", "idle", "waiting", "unavailable"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const sourceInfoSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  slug: z.string().min(1).max(80),
  kind: sourceKindSchema,
  alpha: z.boolean(),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
  fps: z.number().int().positive().max(240),
  status: sourceStatusSchema,
});
export type SourceInfo = z.infer<typeof sourceInfoSchema>;

export function isWatchable(status: SourceStatus): boolean {
  return status === "live" || status === "idle";
}

export const signalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sdp"), type: z.enum(["offer", "answer"]), sdp: z.string().max(200_000) }),
  z.object({
    kind: z.literal("ice"),
    candidate: z.string().max(2_000),
    sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().nullable(),
  }),
]);
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

const subId = z.string().min(1).max(64);
const peerName = z.string().min(1).max(64);

export const peerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), secret: z.string().max(128), peerName, protocolVersion: z.number().int() }),
  z.object({ type: z.literal("welcome"), peerName, protocolVersion: z.number().int() }),
  z.object({ type: z.literal("reject"), reason: z.enum(["bad-secret", "version", "full"]) }),
  z.object({ type: z.literal("sources"), sources: z.array(sourceInfoSchema).max(32) }),
  z.object({ type: z.literal("subscribe"), subId, sourceId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("unsubscribe"), subId }),
  z.object({ type: z.literal("signal"), subId, payload: signalPayloadSchema }),
  z.object({ type: z.literal("kick"), reason: z.string().max(200) }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type PeerMessage = z.infer<typeof peerMessageSchema>;
export type RejectReason = Extract<PeerMessage, { type: "reject" }>["reason"];

/** Viewer page / dashboard preview → local Hub. */
export const viewerInboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("watch"), peer: z.string().min(1).max(80), source: z.string().min(1).max(80) }),
  z.object({ type: z.literal("signal"), subId, payload: signalPayloadSchema }),
  z.object({ type: z.literal("ice-failed"), subId }),
]);
export type ViewerInbound = z.infer<typeof viewerInboundSchema>;

/** Local Hub → viewer page. */
export type ViewerOutbound =
  | { type: "watching"; subId: string; source: SourceInfo; iceServers: IceServer[] }
  | { type: "unavailable" }
  | { type: "ended"; subId: string }
  | { type: "signal"; subId: string; payload: SignalPayload };

/** Publisher window → local Hub. */
export const publisherInboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("signal"), subId, payload: signalPayloadSchema }),
  z.object({ type: z.literal("unsubscribe"), subId }),
  z.object({ type: z.literal("source-status"), sourceId: z.string().min(1).max(64), status: sourceStatusSchema }),
  z.object({ type: z.literal("health"), struggling: z.boolean() }),
]);
export type PublisherInbound = z.infer<typeof publisherInboundSchema>;

/** Local Hub → Publisher window. */
export type PublisherOutbound =
  | { type: "subscribe"; subId: string; sourceId: string; iceServers: IceServer[] }
  | { type: "unsubscribe"; subId: string }
  | { type: "signal"; subId: string; payload: SignalPayload };

export function parseMessage<T>(schema: z.ZodType<T>, raw: string): T | null {
  if (raw.length > MAX_MESSAGE_CHARS) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
