import { join } from "node:path";
import { app } from "electron";
import { startAppCore, type AppCore } from "./app-core";

// `--profile=<name>` runs an isolated instance (own userData), e.g. two Hives on one machine.
const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.slice("--profile=".length);
if (profileArg !== undefined) {
  if (/^[\w-]{1,32}$/.test(profileArg)) app.setPath("userData", join(app.getPath("appData"), `Hive-${profileArg}`));
  else console.error(`[hive] ignoring invalid --profile value (use 1-32 of A-Z a-z 0-9 _ -)`);
}

// One instance per profile: the lock is scoped to the userData directory set above.
if (!app.requestSingleInstanceLock()) {
  console.error(`[hive] another Hive instance is already running with this profile (${app.getPath("userData")}); exiting`);
  app.exit(0);
} else {
  run();
}

function run(): void {
  app.on("window-all-closed", () => {
    // The Publisher window is hidden; the app lives until explicitly quit (dashboard in Plan 4).
  });

  let startup: Promise<AppCore> | null = null;
  let shutdownStarted = false;

  app.on("before-quit", (e) => {
    if (!startup || shutdownStarted) return;
    // Hold the quit until startup has finished (so everything it created is torn down)
    // and the Hub has said goodbye and the server is closed.
    e.preventDefault();
    shutdownStarted = true;
    startup
      .then((core) => core.shutdown())
      .catch((err: unknown) => console.error("[hive] shutdown failed:", err))
      .finally(() => app.quit());
  });

  // Ctrl+C in the terminal / termination: go through before-quit so shutdown runs.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());

  app
    .whenReady()
    .then(() => {
      startup = startAppCore(process.argv);
      return startup;
    })
    .catch((err: unknown) => {
      console.error("[hive] startup failed:", err);
      app.exit(1);
    });
}
