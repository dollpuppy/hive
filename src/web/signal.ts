import type { SignalPayload } from "../shared/protocol";

export type IcePayload = Extract<SignalPayload, { kind: "ice" }>;

export interface CandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export function toIcePayload(c: CandidateLike): IcePayload {
  return { kind: "ice", candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
}

export function fromIcePayload(p: IcePayload): { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } {
  return { candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex };
}
