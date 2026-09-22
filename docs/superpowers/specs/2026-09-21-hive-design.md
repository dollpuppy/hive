# Hive — P2P Co-Stream Source Sharing — Design

**Date:** 2026-09-21
**Status:** Approved in brainstorming, pending spec review

## 1. Purpose

Two streamers doing a collab (e.g. Pokémon Soul Link) each need the other's gameplay, webcam, and VTuber model on their own stream layout, in real time. Hive is a Windows desktop app that both streamers run. Each streamer **publishes** their own sources and **receives** their partner's sources. Every received source gets its own stable `localhost` URL that the streamer adds to OBS as a Browser Source, and can optionally also be output as a Spout2 sender.

Setup goal: install Hive once, send your partner one link.

## 2. Scope

**In v1**
- Windows only (Spout2 is Windows-only).
- Exactly 2 participants per session. Data model is keyed by peer so groups can be added later without changing URLs or protocol shape.
- Source types: window/screen capture, webcam, Spout2 sender, browser-source URL.
- Alpha transparency for Spout2 sources only.
- Optional per-received-source Spout2 output (in addition to the browser-source URL).
- Video only.
- Cloudflare quick tunnel (`*.trycloudflare.com`) for hosting.

**Out of scope for v1**
- Audio of any kind (voice stays on Discord).
- Streamer.bot integration.
- Groups larger than 2.
- macOS / Linux.
- Alpha for browser-source URLs.
- Auto-update.

## 3. Architecture

Electron app (**Electron ≥ 40**, required by texture-bridge). Chromium supplies WebRTC (with hardware H.264 encode), window capture, webcam access, and offscreen rendering. Spout2 send and receive use [`@napolab/texture-bridge`](https://github.com/naporin0624/electron-texture-bridge) (`-renderer` package; MIT; napi-rs prebuilt `win32-x64-msvc` binary) — no custom native code. `cloudflared.exe` is bundled.

### 3.1 Units

| Unit | Responsibility | Talks to |
|---|---|---|
| **Hub** (main process) | HTTP + WebSocket server on `127.0.0.1:7420`; session state; signaling router; config persistence | Dashboard, Publisher, viewer pages (local WS); partner Hub (via tunnel WS) |
| **Tunnel manager** (main process) | Spawns/stops `cloudflared`, parses the public URL from its output, restarts on failure | Hub |
| **Publisher** (hidden BrowserWindow, trusted local content only) | Owns local source MediaStreams; creates one `RTCPeerConnection` per remote subscriber; applies encoding params | Hub (signaling), Spout input (frames) |
| **Spout input** (main process + Publisher) | `SenderDiscovery` lists Spout senders with added/removed events; `createSharedTextureReceiver` delivers each frame zero-copy into the Publisher as a GPU-backed `VideoFrame` | Hub (sender list), Publisher |
| **Spout output** (main process) | For received sources with Spout output enabled: `createTextureBridge` renders the local viewer page offscreen and publishes it as a Spout sender with alpha | Hub |
| **Browser-source renderer** (offscreen BrowserWindow per URL source) | Renders a URL at a fixed size; emits frames | Publisher |
| **Dashboard** (BrowserWindow) | UI only; all actions go through Hub API | Hub |
| **Viewer page** (`/s/<peer>/<source>`, loaded by OBS) | Receives one source over WebRTC; unpacks alpha; renders full-canvas | Hub (local WS signaling) |

### 3.2 Hosting vs. joining

- The local server on `127.0.0.1:7420` runs whenever the app is open. It serves the dashboard API and OBS viewer pages.
- **Start Server** additionally starts the Cloudflare tunnel, which makes this Hub reachable by partners. This is only needed by whoever sends the invite.
- **Join** connects this Hub outward to the partner's tunnel. It works whether or not the joiner's own server is started.
- Once two Hubs are connected, the relationship is symmetric: both publish, both receive.

### 3.3 Connect flow

1. Host clicks **Start Server**. Tunnel comes up; a new invite secret is generated.
2. Host clicks **Copy invite link** → `https://<name>.trycloudflare.com/join#<secret>`.
3. Joiner pastes the link into Hive's Join box and clicks **Join**. (Alternatively, opening the link in a browser shows a landing page with a `hive://join?...` deep link that opens the app.)
4. Joiner's Hub opens WSS to `<tunnel>/hub`, sends `hello` with the secret and its display name. Host validates the secret.
5. Hubs exchange source lists (`sources` message) and keep each other updated on changes.
6. Each streamer sees the partner's tab with sources and **Copy URL** buttons.

### 3.4 Media path (key decision)

OBS viewer pages connect **directly** to the partner's Publisher over WebRTC. Hubs only relay signaling (offer/answer/ICE):

`viewer page ⇄ local Hub ⇄ (tunnel WSS) ⇄ partner Hub ⇄ partner Publisher`

Media then flows P2P from partner Publisher to viewer page.

Rationale: forwarding a received track through the local app into OBS would force a decode and re-encode (quality loss, CPU). Direct connections also make sharing **on-demand**: a source is only encoded and uploaded while at least one viewer (OBS page or dashboard preview) is subscribed. Dashboard previews are just another subscriber using the same path.

NAT traversal: public STUN servers by default. Optional TURN server (URL, username, credential) in settings.

## 4. Signaling protocol

JSON messages over WebSocket. Every message has `type`. Hub-to-Hub messages:

| type | Direction | Fields |
|---|---|---|
| `hello` | joiner → host | `secret`, `peerName`, `protocolVersion` |
| `welcome` | host → joiner | `peerName`, `protocolVersion` |
| `reject` | host → joiner | `reason` (`bad-secret`, `version`, `full`) |
| `sources` | both | `sources: [{ id, name, slug, kind, alpha, width, height, fps, status }]` — full list, sent on connect and on every change |
| `subscribe` | viewer side → publisher side | `subId`, `sourceId` |
| `unsubscribe` | viewer side → publisher side | `subId` |
| `signal` | both | `subId`, `payload` (SDP offer/answer or ICE candidate) |
| `kick` | either | `reason` |
| `ping` / `pong` | both | — |

Local viewer page ↔ local Hub uses the same `subscribe`/`unsubscribe`/`signal` messages; the Hub assigns `subId` and forwards to the partner Hub. The **publisher side creates the offer**.

`kind` ∈ `window | webcam | spout | url`. `status` ∈ `live | idle | waiting | unavailable`.

A `hello` while a partner is already connected is rejected with `full` (v1 limit of 2).

## 5. Dashboard UI

Approved mockup: `.superpowers/brainstorm/384-1790033008/content/dashboard-layout-v3.html`.

**Palette (dark graphite, purple accent)**

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0f1113` | window background, inputs |
| `--surf` | `#171a1d` | top bar, rows |
| `--surf2` | `#1e2226` | secondary buttons, tags |
| `--line` | `#2a2f35` | borders |
| `--tx` | `#e7e9ec` | text |
| `--mut` | `#8a939d` | secondary text |
| `--acc` | `#a855f7` | primary buttons (Copy invite, Copy URL), active tab underline, alpha tag |
| `--ok` | `#4ade80` | live indicators, Start Server button |
| `--bad` | `#f87171` | Stop Server button, errors |
| `--warn` | `#f59e0b` | unavailable / struggling states |

**Top bar** (left to right)
- **Start Server** (green outline) / **Stop Server** (red outline) toggle.
- **Copy invite link** (purple fill; disabled when server stopped).
- Flexible spacer.
- Invite paste input, right-aligned, `min-width` fits the placeholder "Paste partner's invite link…".
- **Join** button.

**Tabs**
- One tab per connected partner (name + green dot), plus **My sources (n)**.
- Partner tab: one row per source — 96×54 live preview thumbnail, name, status tag, resolution/fps, alpha tag if applicable, recommended OBS size, **Copy URL**, and a **Spout out** toggle (off by default). When on, the row shows the Spout sender name to pick in OBS's Spout2 source.
- My sources tab: one row per source — preview, name, device/window/sender tag, preset, viewer count, **Edit**. Final row: **+ Add source**.
- When no partner connected: empty-state note "No partners yet — start the server and send your invite link, or paste theirs."

**Add / Edit source**
1. Pick type: Window/Screen, Webcam, Spout2 (live list of senders), Browser URL.
2. Type-specific picker (window list with thumbnails, device list, sender list, or URL + width/height).
3. Name (becomes URL slug).
4. Quality preset.
5. Spout2 sources show alpha as on (not editable). Other types show no alpha option.

Inline hints:
- Webcam type: "If OBS is already using this camera, add a Spout2 filter to it in OBS and share it as a Spout2 source instead."
- Window type: "Exclusive-fullscreen games capture as black — use borderless windowed, or share via OBS's Spout2 filter."

**Other UI**
- Partner tab has a **Kick** action.
- Settings: display name, TURN server, keep invite secret stable toggle.
- Banners: tunnel URL changed, upload struggling, P2P failed (TURN hint), port fallback.

## 6. Capture & publish pipeline

### 6.1 Capture per type

| Type | Mechanism |
|---|---|
| Window/Screen | Electron `desktopCapturer` source id → `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId }}})` with frame-rate/size constraints from preset |
| Webcam | `getUserMedia({ video: { deviceId, width, height, frameRate }})` |
| Spout2 | texture-bridge `createSharedTextureReceiver({ senderName, target: publisherWindow, extraArgs: [sourceId] })` routes each shared-texture frame to its Publisher-side consumer by `sourceId` (no CPU readback) → alpha packing (6.2) → `canvas.captureStream()`. texture-bridge's frame pool closes each `VideoFrame` after the synchronous handler returns; consumers never close it themselves. Sender picker is fed by `SenderDiscovery`. |
| Browser URL | Rendered in an offscreen `BrowserWindow` with `useSharedTexture`; frames are forwarded zero-copy into the Publisher via `forwardSharedTexture` and drawn letterboxed onto a canvas → `canvas.captureStream()` (opaque) |

### 6.2 Alpha packing (Spout2 only)

- **Sender:** WebGL on an `HTMLCanvasElement` of size `2W × H`; the incoming `VideoFrame` is uploaded with `texImage2D` (GPU-to-GPU). Left half = RGB of the frame. Right half = alpha replicated into RGB as greyscale. The canvas is published via `canvas.captureStream()`.
- **Receiver (viewer page):** WebGL shader samples RGB from `u ∈ [0, 0.5)` and alpha from the red channel at `u + 0.5`; draws to a transparent canvas sized `W × H`.
- Bitrate for alpha sources = preset bitrate × 1.6.
- `sources` message reports logical `width`/`height` (W × H), not packed size.

### 6.3 Encoding

| Preset | Resolution | FPS | Max bitrate |
|---|---|---|---|
| Low | 1280×720 | 30 | 2.5 Mbps |
| Med | 1920×1080 | 30 | 5 Mbps |
| High | 1920×1080 | 60 | 8 Mbps |

Defaults: game/window = Med, webcam = Low, Spout2 = Low, browser URL = Low.

- Codec preference: H.264 first, VP8 fallback (`setCodecPreferences`).
- `RTCRtpSender.setParameters`: `maxBitrate`, `maxFramerate` from preset.
- `degradationPreference`: `maintain-resolution` for window/screen and URL; `balanced` for webcam and Spout2.
- Each subscriber gets its own `RTCPeerConnection` and its own encode.
- "Upload struggling" = outbound `qualityLimitationReason === 'bandwidth'` for > 5 s on any sender, read from `getStats()` every 2 s.

### 6.4 Spout output for received sources

Optional alternative to the browser-source URL, per received source.

- Toggle **Spout out** on a partner source row → main process calls `createTextureBridge({ name, width, height, frameRate, rendererUrl: <local viewer page URL>, includeAlpha: true, pixelExact: true })`.
- The offscreen window loads the same viewer page OBS would load, so it subscribes over WebRTC, unpacks alpha, and renders; texture-bridge publishes the result as a Spout sender. No re-encode: the video is decoded once, as in OBS.
- Sender name: `Hive - <partner name> - <source name>` (stable across sessions, same rule as URLs).
- In OBS, the streamer adds a Spout2 source (requires the Off World Live **obs-spout2-plugin**) and picks the sender.
- Size/frame rate come from the source's logical W × H and fps; resized if the partner changes preset.
- Toggle off, partner disconnect with no reconnect, or Kick → `bridge.dispose()`.
- Toggle state is persisted per partner/source name.

## 7. Viewer pages & URLs

- URL: `http://localhost:<port>/s/<partner-slug>/<source-slug>`. Slugs are lowercased display name / source name, non-alphanumerics → `-`.
- URLs are built from names, not session IDs, so OBS scenes keep working across sessions.
- Collision: second partner or source with the same slug gets `-2`, `-3`, …
- Query options: `?fit=contain` (default, letterbox) or `?fit=cover` (crop-fill).
- Page background always transparent. When the partner is offline or the source isn't live, nothing is drawn.
- Auto-reconnect with exponential backoff (1 s → max 10 s). No manual OBS refresh needed.
- Dashboard shows recommended OBS browser-source size (the source's logical W × H) next to Copy URL.

## 8. Security

- Local server binds `127.0.0.1` only.
- The tunnel forwards only `/hub` (WebSocket) and `/join` (static landing page). All other paths return 404 when the request arrives via the tunnel. Tunnel requests are identified by the `Cf-Connecting-Ip` header, which only the Cloudflare tunnel sets.
- Invite secret: 128-bit random, base64url, carried in the URL fragment (never sent to Cloudflare in the landing-page request). `hello` must present it; compare in constant time.
- New secret on every Start Server unless "keep invite secret stable" is on.
- Partners see only sources the user has added. Kick closes the Hub link and all peer connections for that partner.

## 9. Persistence

`%APPDATA%/Hive/config.json`:
- `version`, `displayName`, `sources[]` (type, device/window/sender/URL reference, name, slug, preset, size for URL sources), `turn` (url, username, credential), `keepSecret`, `secret` (only if keepSecret), `spoutOut` (list of `{ partnerSlug, sourceSlug }` with Spout output enabled), window bounds.
- On launch, sources restore in `idle`. Window sources whose window no longer exists → `unavailable`.
- Config has a `version` field; loader migrates older versions.

## 10. Error handling

| Failure | Behavior |
|---|---|
| `cloudflared` fails to start or tunnel drops | Auto-restart up to 3 times with backoff. If the URL changes, banner: "Invite link changed — resend it." Existing P2P video continues (only signaling used the tunnel). After 3 failures: error state with Retry. |
| Partner Hub disconnects | Partner tab greys out with "reconnecting…". Joiner side retries the same link for 60 s. Viewer pages draw nothing and resume automatically. |
| P2P connection fails (ICE `failed`, or not `connected` within 10 s) | Banner: "Direct connection failed — add a TURN server in Settings", with help link. |
| Spout sender disappears | `SenderDiscovery` `removed` event → source `waiting`; receiver disposed. `added` event for the same name → receiver recreated, source resumes. |
| Spout output fails to start | Row toggle reverts to off with an inline error; browser-source URL still works. |
| Window closed / webcam unplugged | Source `unavailable` (amber); user must Edit to re-pick. |
| Port 7420 busy | Try 7421–7429. Banner warns that OBS URLs use the new port. Fail with a clear error if none free. |
| Upload saturated | "Upload struggling" badge with suggestion to lower a preset. |
| `hello` rejected | Joiner shows reason: wrong/expired link, version mismatch, or host already has a partner. |

## 11. Testing

- **Unit (Vitest):** signaling message validation, slug + collision logic, config load/migrate, invite link parse/validate, preset → encoding params, tunnel URL parsing from `cloudflared` output.
- **Integration:** two Hive Hubs in one test process on different ports, joined over direct `ws://127.0.0.1` (no tunnel). Verify handshake, source-list exchange, subscribe/signal routing, kick, reconnect. Playwright loads a viewer page and asserts decoded frames arrive (fake source = canvas test pattern).
- **Alpha golden test:** known RGBA pattern → pack → encode → decode → unpack; assert alpha per region within tolerance.
- **Spout round-trip smoke test:** in one Electron test process, `createTextureBridge` sends a known RGBA pattern (with transparent regions) as a Spout sender; `createSharedTextureReceiver` receives it; assert frame size and that alpha survives. Covers both directions of texture-bridge.
- **Manual checklist:** two real PCs over the tunnel; OBS browser sources for all four types; VSeeFace with transparency; Spout out into OBS's Spout2 source with transparency; tunnel restart; partner disconnect/reconnect; strict-NAT failure message.

## 12. Open risks

- `MediaStreamTrackGenerator` availability in the shipped Electron/Chromium version — verify at project setup; fallback is `canvas.captureStream()`.
- **Alpha on Spout receive:** texture-bridge documents alpha explicitly only for sending. Frames arrive as `bgra`/`rgba`, so alpha should survive, but verify with VSeeFace in the first spike. Fallback: the RGBA-readback receiver (`createTextureReceiver`).
- **texture-bridge maturity:** pre-1.0 (v0.15.0), low adoption (~170 downloads/month), single maintainer. Pin the exact version. MIT licence allows forking if it stalls.
- OBS browser source (CEF) must support WebRTC H.264 decode; verify on current OBS. VP8 fallback covers it if not.
- Cloudflare quick tunnels are best-effort with no uptime guarantee; acceptable for v1.

## 13. Implementation notes (from plans)

- Degradation preference is expressed with `MediaStreamTrack.contentHint` (`"detail"` for window/url, `""` for webcam/spout) instead of `RTCRtpSendParameters.degradationPreference`.
- Encoding limits are set via `addTransceiver(..., { sendEncodings })`; codec order via `setCodecPreferences` (H.264, VP8, rest).
- Local message families: viewer (`watch`, `signal`, `ice-failed` ⇄ `watching`, `unavailable`, `ended`, `signal`) and publisher (`subscribe`, `unsubscribe`, `signal` ⇄ `signal`, `unsubscribe`, `source-status`, `health`). ICE servers travel in `watching` and publisher `subscribe`.
- The viewer sends `ice-failed` only when a session never reached `connected` (ICE failure or 10 s connect timeout); a session that connected and later dropped just retries.
- A newer Publisher connection replaces the old one, which is closed with code `4001` (`PUBLISHER_REPLACED_CLOSE_CODE`, `src/shared/close-codes.ts`); a client closed with 4001 halts instead of reconnecting.
- Viewer URL peer segment `me` is reserved for previews of your own sources; partners never get that slug.
- `/local/publisher` is protected by a per-launch token; `/local/viewer` by an Origin allowlist (own origin, `file://`, dev server). Chromium sends `Origin: file://` on WebSocket handshakes from `file:` pages.
- Window capture: each open (select-window IPC + `getDisplayMedia()`) is serialized and times out after 10 s. Main grants display-media only to the Publisher's top-level frame, for a one-shot window selection that expires after 10 s.
- Source status `idle` means ready (capture starts on first subscriber); `live` means capturing.
- Plan 3: publisher frames from Spout/URL sources are drawn to canvases and published with `canvas.captureStream()` rather than `MediaStreamTrackGenerator`.
