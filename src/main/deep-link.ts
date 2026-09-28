export const PROTOCOL = "hive";

/** Finds `hive://join?link=<encoded invite>` in argv (Windows passes deep links as arguments). */
export function inviteFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (!arg) return null;
  try {
    return new URL(arg).searchParams.get("link");
  } catch {
    return null;
  }
}
