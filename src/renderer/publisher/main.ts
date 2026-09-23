import type { SourceConfig } from "../../main/config/config-store";
import { encodingFor } from "../../shared/presets";
import type { HivePublisherApi } from "../../shared/publisher-api";
import { PublisherClient } from "../../web/publisher-client";
import { CaptureManager } from "./capture-manager";
import { openSpout, openUrl } from "./gpu-openers";
import { openWebcam, openWindow } from "./openers";
import { SpoutNames, applySpoutAvailability } from "./spout-names";

const params = new URLSearchParams(location.search);
const port = params.get("port");
const token = params.get("token");
const api: HivePublisherApi = window.hivePublisher;

let sources: SourceConfig[] = [];
// Spout sender names currently available, kept in sync by onSpoutAvailability events
// and seeded from spoutSenders(). Source ids are mapped to names via `sources`.
const spoutNames = new SpoutNames();

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
  applySpoutAvailability(next, spoutNames, (id, available) => captures.setAvailability(id, available));
}

// Listen before fetching so a change pushed during the fetch is not lost; a pushed list
// is newer than the fetched one, so the fetch result is dropped once a push has arrived.
let pushed = false;
api.onSourcesChanged((next) => {
  pushed = true;
  applySources(next);
});

// Subscribe to availability before awaiting spoutSenders() so an event that arrives
// during the fetch is not lost (SpoutNames lets such events win over the snapshot).
// Sources pushed while the fetch is in flight are applied against an incomplete name
// set and read as "waiting", so availability is re-applied to every current Spout
// source once the snapshot has merged (or the fetch has failed).
api.onSpoutAvailability((name, available) => {
  spoutNames.update(name, available);
  for (const s of sources) {
    if (s.kind === "spout" && s.senderName === name) captures.setAvailability(s.id, available);
  }
});
try {
  spoutNames.loadSnapshot(await api.spoutSenders());
} catch (err) {
  spoutNames.endFetch();
  // Spout sources read as "waiting" until an onSpoutAvailability event reports them.
  console.error("hive publisher: could not load spout senders", err);
}
applySpoutAvailability(sources, spoutNames, (id, available) => captures.setAvailability(id, available));

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
