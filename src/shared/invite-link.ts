export interface ParsedInvite {
  hubUrl: string;
  secret: string;
}

/** `https://<host>/join#<secret>` (or http: for local testing) -> the hub URL and secret; null if malformed. */
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

/** The host (with port, if any) a valid invite link points at, for display ("Join <host>?"); null if invalid. */
export function inviteHost(link: string): string | null {
  return parseInviteLink(link) ? new URL(link.trim()).host : null;
}
