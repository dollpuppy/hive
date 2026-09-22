import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateSecret(): string {
  return randomBytes(16).toString("base64url");
}

export function secretsEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildInviteLink(tunnelUrl: string, secret: string): string {
  return `${tunnelUrl.replace(/\/+$/, "")}/join#${secret}`;
}

export interface ParsedInvite {
  hubUrl: string;
  secret: string;
}

export function parseInviteLink(link: string): ParsedInvite | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : null;
  const secret = url.hash.slice(1);
  if (scheme === null || url.pathname !== "/join" || secret === "") return null;
  return { hubUrl: `${scheme}//${url.host}/hub`, secret };
}
