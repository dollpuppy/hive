# Hive Plan 1 (Core) — follow-ups from review

Plan 1 was executed on branch `feat/hive-core`. Reviews found defects in the plan's own code; the ones below were **fixed beyond the plan** and later plans must assume the fixed behavior:

| Area | Behavior now |
|---|---|
| `config-store` | Top-level JSON arrays are treated as corrupt. Renames retry on `EPERM`/`EBUSY`/`EACCES`. Saves are serialized per file and use unique temp names. |
| `TunnelManager` | `stop()` detaches synchronously and emits `stopped` immediately, so `stop(); start()` works. |
| `Hub` | Replacing a publisher ends its subs and ignores the old channel. A joiner Hub that is already partnered refuses a second welcome and emits `rejected` with `"already-partnered"`. Rejected/closed links can't re-handshake. A partner `unsubscribe` only ends subs the partner is part of. Incoming links time out after 10 s (`handshakeTimeoutMs`). `kick()` emits a local `kicked-partner` event. |
| `local-server` | Unparseable request targets get a 400. A route that throws gets a 500. Port fallback also skips `EACCES`/`EADDRNOTAVAIL`, which covers Windows excluded port ranges. |
| `joiner` | A remote `full` after a successful connect is retried until the deadline. A half-open link is terminated when the Hub drops the partner. `welcomeTimeoutMs` defaults to 10 s. Hub events count only for the joiner's own link. The deadline is refreshed on a clean disconnect. A window that expires after `full` reports `failed "full"`. It refuses to start when already partnered (`failed "already-partnered"`). A local kick stops the joiner. `JoinDetail` is exported. |

## Open design decisions (need an owner)

1. **Tunnel detection fails open** (`local-server.ts` `isViaTunnel`). A request without `cf-connecting-ip` is treated as local. If Cloudflare ever stops adding it (for example a named tunnel with visitor-IP headers removed), remote clients reach `/local/viewer` (no `Origin` required) and local-only HTTP routes. Option: point cloudflared at a separate listener that serves only `/hub` and `/join`, and keep the header check as a second layer.
2. **No `Host` check on local HTTP routes.** A DNS-rebinding page can read local HTTP responses (not WebSockets). This matters once a route serves anything sensitive (publisher token, config). Option: require `Host` to be `127.0.0.1:<port>` or `localhost:<port>` for non-tunnel requests.
3. **Mutual simultaneous join.** A and B each join the other at the same moment, and both end up with no partner. Needs a deterministic tie-break, for example by comparing secrets or names.
4. **Stale host link after a joiner blip.** The host answers `full` until its heartbeat drops the old link (30–40 s). The joiner now retries through this, but the host could instead replace a silent link when a valid hello arrives.

## Items for Plan 2 (Media)

- `PublisherClient` must **not** auto-reconnect when the Hub closes it as `replaced`. Otherwise two publishers replace each other every second. Close codes are currently not distinguishable: `replaced`, `kicked`, `rejected` and `already partnered` all use 1000. Consider app codes such as 4001 replaced, 4002 kicked, 4003 rejected, and branch on them.
- Before quitting, stop the join handle before calling `hub.dispose()`. `dispose()` emits `partner: null`, and a running joiner would schedule a reconnect.

## Items for Plan 4 (Dashboard)

- `joinStatusText` needs entries for `already-partnered` (as either `failed` or `rejected` detail) and `failed "full"`. Switch on the exported `JoinDetail` type.
- The joiner emits repeated `connected` statuses (on every partner source-list change) and repeated `reconnecting` statuses. The UI should show only the latest one.
- `SessionController.kick()` on the joining side now works through the Hub's `kicked-partner` event. No extra `stopJoin()` is needed, but calling it is harmless.

## Hardening backlog (minor)

- `/hub` has no `Origin` check and no cap on pending handshakes. Refuse `/hub` upgrades that carry an `Origin` header (the Node joiner sends none) and cap pending unauthenticated links.
- There is no per-partner cap on subscribes. Each subscribe is a PeerConnection in the Publisher.
- The viewer handler's `mine` set keeps ended subIds until the viewer closes.
- The joiner's `linked` gate checks "our socket is open", not "the partner came from our link". There is a narrow race if an incoming partner arrives while our welcome is pending.
- The joiner's local kick calls `terminate()` right after `kick()` queues the kick message. Over a slow tunnel the message could be dropped, and the host would then see a plain disconnect. Terminate after a short grace period or after the close handshake instead.
- `saveConfig` tmp cleanup (`rm`) could mask the original rename error if it throws.
