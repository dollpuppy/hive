import { join } from "node:path";
import { app } from "electron";
import { startAppCore, type AppCore } from "./app-core";

// `--profile=<name>` runs an isolated instance (own userData), e.g. two Hives on one machine.
const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.slice("--profile=".length);
if (profileArg !== undefined) {
  if (/^[\w-]{1,32}$/.test(profileArg)) app.setPath("userData", join(app.getPath("appData"), `Hive-${profileArg}`));
  else console.error(`[hive] ignoring invalid --profile value (use 1-32 of A-Z a-z 0-9 _ -)`);
}

app.on("window-all-closed", () => {
  // The Publisher window is hidden; the app lives until explicitly quit (dashboard in Plan 4).
});

let core: AppCore | null = null;
let quitting = false;

app.on("before-quit", (e) => {
  if (!core || quitting) return;
  // Hold the quit until the Hub has said goodbye and the server is closed.
  e.preventDefault();
  quitting = true;
  core
    .shutdown()
    .catch((err: unknown) => console.error("[hive] shutdown failed:", err))
    .finally(() => app.quit());
});

app
  .whenReady()
  .then(async () => {
    core = await startAppCore(process.argv);
  })
  .catch((err: unknown) => {
    console.error("[hive] startup failed:", err);
    app.exit(1);
  });
