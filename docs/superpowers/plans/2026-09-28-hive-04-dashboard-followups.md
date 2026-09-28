# Hive Plan 4 (Dashboard) — follow-ups from review

Plan 4 was executed on branch `feat/hive-dashboard` (`git log 354f5ab..HEAD`). The plan predated Plans 2–3, so its `app-core.ts`/`index.ts` code was adapted rather than pasted, Task 2 was skipped (Plan 2 already restarts captures on config change), and two tasks were added (4b Spout output hardening, 4c URL-source loopback blocking). Reviews found defects that were **fixed beyond the plan**:

| Area | Behavior now |
|---|---|
| `SessionController` | Single config store for Hub, Publisher (`hive:publisher:sources`) and Spout outputs. Applies state and side effects before awaiting the save; awaited actions reject on save failure, fire-and-forget saves log. Join statuses are deduped. `retrySource(id)` re-sends sources. `publisher-down` banner. Inline `spoutOutErrors` plus the `spout-output-failed` banner. Secret is null until Start Server; a non-kept secret is scrubbed from disk. |
| Partner disconnect | The last partner is kept for 60 s (`partner.connected: false`, greyed "reconnecting…" tab) and Spout outputs stay up; kick, kicked, Leave and Stop Server skip the grace. Syncs during grace use the kept partner. `join()` is refused while a partner is connected. Stop Server kicks an inbound partner. |
| Spout outputs | Partner sizes clamped to 3840×2160 @ 60. A failed `createTextureBridge` retries at 1/2/4 s before `onError`. texture-bridge 0.15.0 recovers from neither a send `error` nor a renderer crash, so both dispose and recreate the bridge (same budget, reset after 30 s stable). |
| URL sources | The `hive-url-sources` session cancels loopback requests (127/8, 0.0.0.0, localhost/*.localhost, ::1, IPv4-mapped IPv6, trailing dots) unless the request comes from the source whose own configured URL is that loopback host:port (attributed by `webContentsId`). Hostname-based only. |
| Dashboard | Served at `http://127.0.0.1:<port>/ui/dashboard/index.html` (not `file://`, so previews can use `/local/viewer`); sandboxed preload; every `hive:dash:*` handler checks the sender is the dashboard's main frame; navigation/redirect/window.open blocked. Saved bounds off every display are recentred. Closing the dashboard quits; before-quit holds quits until shutdown finishes. |
| Deep links | `hive://join?link=…` (hostname must be `join`) is **offered** (prefilled + "Join <host>?" prompt), never auto-joined. `--join=` auto-joins only in unpackaged builds. `hive://` isn't registered for `--profile` instances. |
| Webcams | Device ids are salted per origin (dashboard http vs Publisher file://), so `openWebcam` resolves the stored id against the Publisher's own devices, then falls back to the exact label. |
| Spout names | `src/shared/spout-name.ts` (`spoutOutputName`, `spoutOutputNames`) is shared by main and the renderer so the dashboard shows the de-duplicated sender name. |
| Packaging | electron-builder 26.15.3 (NSIS, x64), cloudflared 2026.9.1 pinned by sha256 in `scripts/cloudflared.lock.json`; `predev`/`prestart`/`dist` fetch it. `win.signAndEditExecutable: false`. |

## Open items

- **Task 10 manual verification is not done** (two PCs, OBS, obs-spout2-plugin, transparent Spout sender). Also confirm webcam labels are available on the Publisher's first `enumerateDevices()` (the label fallback depends on it), and carry over the Plan 2/3 manual checks.
- Spec §9 launch-time "window no longer exists → unavailable" is not implemented (first open marks it; Retry exists).
- Spec §10 TURN help link: there is no help page to link to yet.
- Loose window-title matching, tray icon, hung-renderer (`unresponsive`) handling, 4002/4003 close codes and the Plan 1 hardening backlog remain open.

## Minor backlog (from reviews)

- Stop Server: the kick frame can race `tunnel.stop()` killing cloudflared; the joiner may then retry a dead URL for 60 s.
- `stopServer` uses "no join handle" as a proxy for "partner joined us"; use the Hub link role.
- `join()` during an outbound partner's grace window leaves a stale "reconnecting…" row for up to 60 s.
- Stale `joinError` / `failed already-partnered` text lingers after refusals.
- `leave()` with an inbound partner and no join handle leaves `kickOrLeavePending` set (can skip a later grace).
- `spout-output-failed` banner isn't cleared on re-enable; `spoutOutErrors` entries are never pruned. `leave()` emits state twice.
- `SpoutOutputs`: `renderWindow.webContents` access unguarded right after create; recovered failures aren't logged.
- Dashboard: no reload after `render-process-gone`; IPC check doesn't verify `senderFrame.url`; maximized state not persisted; no shutdown watchdog.
- Renderer: `spellcheck: false` is dropped by `h()`; keyboard focus lost on re-render (except the invite box); unhandled rejections in `setSpoutOut`/`removeSource`/`listWindows`; Kick has no confirmation.
- `/join` lacks `x-content-type-options: nosniff`; `offerInvite` doesn't cap link length; `::` isn't treated as loopback.
- `signAndEditExecutable: false` also skips exe icon/version resources — revisit with signing and an icon. `fetch-cloudflared` writes non-atomically.
- Commits 0daec69, 84f0682, c2d2df2 have cosmetic trailer issues.

## Test gaps

- `app-core.ts`/`index.ts` wiring (deep-link offer, second-instance, shutdown order) has no automated test.
- Still no Electron end-to-end test of the real Publisher/dashboard (carried over from Plans 2–3).
