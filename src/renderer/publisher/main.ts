import type { SourceConfig } from "../../main/config/config-store";
import { encodingFor } from "../../shared/presets";
import type { HivePublisherApi } from "../../shared/publisher-api";
import { PublisherClient } from "../../web/publisher-client";
import { CaptureManager } from "./capture-manager";
import { openSpout, openUrl } from "./gpu-openers";
import { openWebcam, openWindow } from "./openers";

const params = new URLSearchParams(location.search);
const port = params.get("port");
const token = params.get("token");
const api: HivePublisherApi = window.hivePublisher;

let sources: SourceConfig[] = [];
// Spout sender names currently available, kept in sync by onSpoutAvailability events
// and seeded from spoutSenders(). Source ids are mapped to names via `sources`.
const spoutNames = new Set<string>();

// The manager and client call into each other; the arrow callbacks only run after both exist.
const captures: CaptureManager = new CaptureManager({
  openers: { window: openWindow, webcam: openWebcam, spout: openSpout, url: openUrl },
  onStatus: (id, status) => client.reportStatus(id, status),
  onEnded: (id) => client.endSource(id),
});

const client: PublisherClient = new PublisherClient({
  url: `ws://127.0.0.1:${port ?? ""}/local/publisher?token=${encodeURIComponent(token ?? "")}`,
  acquire: (id) => captures.acquire(id),
  release: (id) => captures.release(id),
  encodingFor: (id) => {
    const s = sources.find((x) => x.id === id);
    return s ? encodingFor(s.preset, s.kind === "spout") : null;
  },
});

function applySources(next: SourceConfig[]): void {
  sources = next;
  captures.setSources(next);
  for (const s of next) {
    if (s.kind === "spout") captures.setAvailability(s.id, spoutNames.has(s.senderName));
  }
}

// Listen before fetching so a change pushed during the fetch is not lost; a pushed list
// is newer than the fetched one, so the fetch result is dropped once a push has arrived.
let pushed = false;
api.onSourcesChanged((next) => {
  pushed = true;
  applySources(next);
});

// Subscribe to availability before awaiting spoutSenders() so an event that arrives
// during the fetch is not lost. The fetched snapshot can be stale relative to any event
// that arrives while it's in flight, so we track which names an event has already
// touched during the fetch and let those names win over the snapshot instead of the
// snapshot clobbering them back.
let fetchingSnapshot = true;
const touchedDuringFetch = new Set<string>();
api.onSpoutAvailability((name, available) => {
  if (fetchingSnapshot) touchedDuringFetch.add(name);
  if (available) spoutNames.add(name);
  else spoutNames.delete(name);
  for (const s of sources) {
    if (s.kind === "spout" && s.senderName === name) captures.setAvailability(s.id, available);
  }
});
try {
  const snapshot = await api.spoutSenders();
  fetchingSnapshot = false;
  for (const name of snapshot) {
    if (!touchedDuringFetch.has(name)) spoutNames.add(name);
  }
} catch (err) {
  fetchingSnapshot = false;
  // Spout sources will read as "waiting" until an onSpoutAvailability "added" event
  // arrives; acceptable degradation rather than blocking the whole page.
  console.error("hive publisher: could not load spout senders", err);
}

try {
  const initial = await api.getSources();
  if (!pushed) applySources(initial);
} catch (err) {
  console.error("hive publisher: could not load sources", err);
}
if (!port || !token) {
  // Main always passes both; without them the client would dial the wrong server or be refused forever.
  console.error("hive publisher: missing port or token in the page URL; not connecting");
} else {
  client.start();
}
