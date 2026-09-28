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

// Pure (no Node APIs) so the dashboard renderer can use it too; re-exported for main-side callers.
export { parseInviteLink, type ParsedInvite } from "../shared/invite-link";
