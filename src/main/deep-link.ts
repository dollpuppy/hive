export const PROTOCOL = "hive";

/** Finds `hive://join?link=<encoded invite>` in argv (Windows passes deep links as arguments). */
export function inviteFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (!arg) return null;
  try {
    const url = new URL(arg);
    // Only the `join` action is a thing; any other hive:// link is ignored. (A non-special
    // scheme's host isn't lowercased by URL, so compare case-insensitively.)
    if (url.hostname.toLowerCase() !== "join") return null;
    return url.searchParams.get("link");
  } catch {
    return null;
  }
}
