# Hive Plan 2 (Media) — follow-ups from review

Plan 2 was executed on branch `feat/hive-media` (`git log bd03adc..HEAD`). Reviews found defects in the plan's own code; the ones below were **fixed beyond the plan** and later plans must assume the fixed behavior:

| Area | Behavior now |
|---|---|
| Close codes | A replaced Publisher is closed with `4001` (`PUBLISHER_REPLACED_CLOSE_CODE`), and `PublisherClient` does not reconnect after it. The constant lives in the dependency-free `src/shared/close-codes.ts` so renderer bundles don't pull in zod through `protocol.ts` (which re-exports it for main and tests). |
| `PublisherClient` | `start()` is idempotent. It re-sends every last-known source status and the current health state on each (re)connect. Duplicate subscribes are ignored. A session that fails to construct or start (e.g. a malformed TURN URL) is released and unsubscribed. Stale session callbacks are ignored. Health sampling doesn't overlap. |
| `ViewerClient` | `ice-failed` is reported only when a session never connected. A session that connected and later dropped just retries. A failure to answer an offer (SDP) retries immediately. `start()` can't open a second socket. |
| `CaptureManager` | Orphaned refs (holders of a capture torn down under them: track ended, source removed or reconfigured) are absorbed before releases reach a newer capture of the same source. A capture-relevant config change (anything but name/slug) stops the live capture, ends its sessions and reports `idle`. A track already ended on arrival fails the open. **`setSources` resets any `unavailable` source that isn't open back to `idle`**, so re-sending the list after a re-pick retries it. `waiting` is left alone. |
| Window openers | `getDisplayMedia` calls are serialized. Each open times out after 10 s (`OPEN_WINDOW_TIMEOUT_MS`) so a hung call can't block the queue. A capture arriving after its timeout is stopped, and a timed-out attempt never calls `getDisplayMedia`. |
| `display-media` | Grants go only to the Publisher's main frame. Requests from any other page are denied **without consuming** the pending selection. The selection is one-shot and valid for 10 s. Windows are matched before screens (screens are only a fallback). |
| Publisher window | Navigation and new windows are blocked. After a renderer crash it reloads with backoff (1 s → 30 s, reset after 30 s stable) and gives up after 5 crashes in 2 min. The page fails loudly (console error, no connection) when `port` or `token` is missing. |
| Hub | On a Publisher **disconnect** (not a replacement), all local sources become `unavailable` through the normal `setLocalSources` broadcast. The reconnecting Publisher's re-sent statuses restore them. The Hub emits `publisher` on attach and detach. |
| `local-server` | `/local/viewer` no longer accepts `Origin: file://`. The only extra origin is the renderer dev server (`viewerDevOrigins()`). `/local/publisher` stays token-only, with no Origin check. |
| Main process | Single-instance lock per profile (userData). SIGINT/SIGTERM quit through `before-quit` so shutdown runs. A quit during startup waits for startup, then tears it down. Shutdown order: joiner, then `hub.dispose()`, then the Publisher window, then the server. The invite line is printed only in unpackaged builds. |

## Open items

- **Task 11 manual OBS verification** (Steps 1–3) is not done yet and needs a human with OBS. Run two instances and add an OBS Browser Source at `http://localhost:7421/s/ana/game`. If OBS shows nothing but Chrome works, test with VP8 first and record the result in the spec's Open risks.
- The SIGINT → shutdown path is untested. The smoke run only used forced kills.
- Residual race: a `getDisplayMedia` that hangs and resolves after a newer `selectWindow` can take the wrong grant. A full fix needs the grant bound to each request.
- Electron 45 moves screen-capture permission to `setPermissionRequestHandler` `display-capture`. Revisit this on upgrade.

## Items for Plan 3 (Spout / URL)

- Spout `waiting` → `idle`/`live` recovery through SenderDiscovery added/removed events. The Hub's `isWatchable` excludes `waiting`, and `CaptureManager.setSources` does not reset it.
- URL sources need:
  - a separate session partition whose permission request/check handlers deny;
  - their own display-media handler that denies;
  - `will-navigate` and window-open guards.

  The default session currently grants camera/mic to any content.
- Never load remote content in the Publisher window: it runs with nodeIntegration on and contextIsolation off for texture-bridge. Keep texture-bridge receivers only in the Publisher page.
- A Spout sender's size may differ from, or change relative to, the preset size reported in `SourceInfo`. Decide what `width`/`height` mean.
- Spout/URL openers must return `Capture.dispose` for receivers and offscreen windows. `contentHint` is applied by `CaptureManager`, not the opener.

## Items for Plan 4 (Dashboard)

- Use a single config store to feed both the `hive:publisher:sources` push (main never sends it yet) and `hub.setLocalSources`, merging statuses instead of resetting them to `idle`. Today `AppCore.config` and the local `config` in `app-core.ts` are separate snapshots.
- Add a retry/"re-pick" action for unavailable sources. Re-sending the sources now resets them to `idle`.
- The launch-time check that window sources still exist (spec §8) is not implemented.
- Window titles must match exactly (first match wins). Titles that change (browsers, games showing FPS) break. The picker should warn or match more loosely. `listCapturableWindows` is ready for the picker.
- Dashboard access to `/local/viewer` needs a custom protocol or a token, because `file://` is no longer allowed.
- Add a `second-instance` handler (focus the dashboard, forward `--join`). Add a tray/quit path (`window-all-closed` does nothing). Show a banner when the Publisher is down or crash-reload gave up (Hub `publisher` event).
- If the Publisher window is ever recreated, the IPC handlers bound to the old webContents must be unregistered and re-bound, because `ipcMain.handle` throws on double registration.
- A hung Publisher renderer (`unresponsive`) is not handled. Only `render-process-gone` is.
- Carry-overs from the Plan 1 follow-ups:
  - `joinStatusText` entries;
  - dedupe repeated statuses;
  - optional `4002`/`4003` close codes for kicked/rejected.

## Test gaps

- The real Publisher path has no automated test: `renderer/publisher/main.ts`, the preload, `display-media`, the `CaptureManager` ↔ `PublisherClient` callbacks, crash reload and shutdown. An Electron Playwright test with `--use-fake-device-for-media-stream` and a webcam source would cover most of it.
