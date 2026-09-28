import { join, resolve } from "node:path";
import { app } from "electron";
import { startAppCore, type AppCore } from "./app-core";
import { inviteFromArgv, PROTOCOL } from "./deep-link";

// `--profile=<name>` runs an isolated instance (own userData), e.g. two Hives on one machine.
const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.slice("--profile=".length);
if (profileArg !== undefined) {
  if (/^[\w-]{1,32}$/.test(profileArg)) app.setPath("userData", join(app.getPath("appData"), `Hive-${profileArg}`));
  else console.error(`[hive] ignoring invalid --profile value (use 1-32 of A-Z a-z 0-9 _ -)`);
}

// One instance per profile: the lock is scoped to the userData directory set above.
if (!app.requestSingleInstanceLock()) {
  // A deep link opened while Hive runs lands here; the running instance gets it via second-instance.
  console.error(`[hive] another Hive instance is already running with this profile (${app.getPath("userData")}); exiting`);
  app.exit(0);
} else {
  run();
}

/**
 * Makes `hive://` links open this app. Under `electron .` (process.defaultApp) Windows must
 * launch electron.exe with the app path. Profiled instances don't register: a protocol launch
 * carries no `--profile`, so it would start (or reach) the default profile, not this one.
 */
function registerProtocol(): void {
  if (profileArg !== undefined) return;
  let ok: boolean;
  if (process.defaultApp) {
    const appPath = process.argv[1];
    ok = appPath !== undefined && app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(appPath)]);
  } else {
    ok = app.setAsDefaultProtocolClient(PROTOCOL);
  }
  if (!ok) console.error(`[hive] couldn't register as the ${PROTOCOL}:// handler`);
}

function run(): void {
  registerProtocol();

  // The dashboard's `closed` quits too; this covers every window going away some other way.
  app.on("window-all-closed", () => app.quit());

  let startup: Promise<AppCore> | null = null;
  let core: AppCore | null = null;
  let shutdownStarted = false;
  let shutdownDone = false;

  // A deep link (or `--join=`, for development) on the command line joins once started.
  const devJoin = process.argv.find((a) => a.startsWith("--join="))?.slice("--join=".length) || null;
  let pendingInvite = inviteFromArgv(process.argv) ?? devJoin;

  // Deep links while running: Windows starts a second instance with the link in argv; it
  // exits (no lock) and we get its argv. The link is validated by the joiner.
  app.on("second-instance", (_event, argv) => {
    if (shutdownStarted) return;
    const invite = inviteFromArgv(argv);
    if (!core) {
      // Still starting: the latest link wins once started.
      if (invite) pendingInvite = invite;
      return;
    }
    core.focus();
    if (invite) core.session.join(invite);
  });

  app.on("before-quit", (e) => {
    if (!startup || shutdownDone) return;
    // Hold the quit until startup has finished (so everything it created is torn down)
    // and the Hub has said goodbye and the server is closed. Quits requested meanwhile
    // (the dashboard's `closed`, a second Ctrl+C) are held too.
    e.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    startup
      .then((c) => c.shutdown())
      .catch((err: unknown) => console.error("[hive] shutdown failed:", err))
      .finally(() => {
        shutdownDone = true;
        app.quit();
      });
  });

  // Ctrl+C in the terminal / termination: go through before-quit so shutdown runs.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());

  app
    .whenReady()
    .then(async () => {
      startup = startAppCore();
      core = await startup;
      if (pendingInvite && !shutdownStarted) core.session.join(pendingInvite);
      pendingInvite = null;
    })
    .catch((err: unknown) => {
      console.error("[hive] startup failed:", err);
      app.exit(1);
    });
}
