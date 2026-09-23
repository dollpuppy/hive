# Hive Plan 3 (Spout / URL) — follow-ups from review

Plan 3 was executed on branch `feat/hive-spout` (`git log 4b1d717..HEAD`). The plan's snippets were adapted to post-Plan-2 code, and reviews found defects that were **fixed beyond the plan**. Later plans must assume the fixed behavior:

| Area | Behavior now |
|---|---|
| texture-bridge | Pinned at `@napolab/texture-bridge-renderer`/`-core` 0.15.0. The RGBA-readback receiver (`createTextureReceiver`) returns **BGRA** on Windows even though the typings say RGBA. `npm run test:spout` passes: alpha survives Spout send → receive. |
| Alpha packing | Packer: `2W×H` `[RGB \| A]` canvas, feeding `canvas.captureStream()` with no frame rate (one frame per draw). Unpacker: recovers alpha from luma, floors codec noise, clamps sampling at the seam, uses NEAREST filtering, and clamps colour in the premultiplied branch. Both survive WebGL context loss/restore. The packer requires an even width. `AlphaPacker.redraw()` re-emits the last frame. |
| Spout source size | A Spout source advertises its **preset** W×H. Sender frames of any size are letterboxed into it (transparent bars). |
| Viewer | Alpha sources: a hidden 2 px feeder `<video>` → `AlphaUnpacker`, driven by `requestVideoFrameCallback` (rAF fallback). `?premultiplied=1` is supported. |
| Publisher IPC | `src/main/publisher-ipc.ts`: every channel checks `isFromPublisher` and validates its arguments. The renderer names sources by id only; main takes the URL/fps/sender name from config. Opens return a **handle**, and a close with a stale handle does nothing. Handlers act synchronously. |
| Spout inputs | `SpoutInputs` refuses Hive's own outputs (`Hive - ` prefix). A missing or unbuildable sender rejects with the `spout-sender-missing:` tag, which the Publisher maps to `waiting`; any other failure maps to `unavailable`. After `ReceiverStoppedError` or a failed construction, a retry "nudge" (`availability true`) is sent with 3 s → 60 s backoff. |
| URL sources | Isolated non-persistent session (`hive-url-sources`) that denies permissions, device access and display capture, and cancels downloads. Windows block navigation to non-http(s) URLs, window-open, webviews, dialogs and audio. Client certificates are never auto-selected (app-wide). Crash and failed-load retries back off; more than 3 failures in 60 s → give up → `hive:publisher:url-failed` → capture ends as `unavailable`. |
| Keepalive | The Publisher redraws the unchanged canvas after ~1 s idle so static pages, paused senders and late joiners still get frames. Main's repeating `invalidate()` was removed because it had no effect. |
| Publisher reload | Main closes all Spout receivers and URL windows on the Publisher's `did-start-navigation`, `did-navigate` and `render-process-gone`. |
| Spout outputs | `SpoutOutputs.sync` runs on every Hub `partner` event. A name or fps change recreates the bridge; a size change resizes it. Names are UTF-8-truncated on code points and de-duplicated with ` (2)`… suffixes. Frame drops are counted (`droppedFrames(key)`). |
| Shutdown | `core.shutdown()` order: joiner → Spout outputs → URL sources → Spout inputs → hub → Publisher → server. |

## Open items

- **Task 12 manual verification is not done.** It needs a human with OBS, the obs-spout2-plugin and a transparent Spout sender (VSeeFace, or the Spout SDK demo sender). Check:
  - alpha through the GPU shared-texture path;
  - which premultiplied setting looks right (`?premultiplied=1` or not);
  - the sender going away and coming back;
  - a URL source;
  - Spout output into OBS's Spout2 source.

  Record the results in spec §12. Also confirm that OBS's CEF keeps decoding the hidden 2 px feeder video, so `requestVideoFrameCallback` keeps firing.
- **Premultiplied packing** (from the review of Tasks 1–4) is undecided: straight-alpha RGB filtered while scaling can give dark fringes. Decide it from Task 12's results. Option: the packer uploads with `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`, and the viewer defaults to `srcPremultiplied`.
- The Spout nudge's 30 s "healthy" window is tracked per sender name. A second source opening the same sender restarts it.

## Items for Plan 4 (Dashboard)

- **Spout output grace period and retry.** Any partner disconnect disposes the bridges straight away, so a brief reconnect makes OBS lose the sender. A `createTextureBridge` rejection is only retried on the next `partner` event. Spec §6.4 says "with no reconnect". Add a grace period (for example the joiner's 60 s window, or until kicked) and create-retry with backoff, and revert the toggle with an inline error (§10).
- **Clamp partner-controlled Spout output sizes.** `protocol.ts` allows up to 7680×4320 @ 240 fps, and these values go straight to `createTextureBridge`. Clamp them to preset maxima.
- **Bridge renderer crash recovery.** Check whether texture-bridge recovers from a crash of its offscreen renderer. If it doesn't, recreate the bridge on `error`.
- **Sender picker** fed by `spoutSenders()` plus availability. A "retry" action for `unavailable` URL sources (re-sending sources resets them to `idle`).
- **URL session: block loopback.** A remote page can navigate its window to `http://127.0.0.1:<port>/s/...`. Nothing leaks, but block it anyway with `ses.webRequest.onBeforeRequest` unless the configured URL is itself local.
- **The app doesn't quit when its windows close.** A plain WM_CLOSE closes the hidden Publisher window but the app keeps running (empty `window-all-closed`), so shutdown never runs. The tray/quit path from the Plan 2 follow-ups covers this.

## Test gaps

- `app-core.ts` wiring is untested: feeds closing on navigation or crash, `partner` → sync, shutdown order.
- The preload frame router is untested, apart from rate-limiting: non-string tags, unregistered sources.
- The viewer's alpha on/off switching is untested.
- Still no automated Electron Publisher end-to-end test (carried over from Plan 2).
