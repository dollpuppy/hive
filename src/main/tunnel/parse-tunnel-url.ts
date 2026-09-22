const TUNNEL_URL = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;

export function parseTunnelUrl(output: string): string | null {
  for (const match of output.matchAll(TUNNEL_URL)) {
    if (match[1]?.toLowerCase() !== "api") return match[0].toLowerCase();
  }
  return null;
}
