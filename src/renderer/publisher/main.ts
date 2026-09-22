import type { SourceConfig } from "../../main/config/config-store";
import { encodingFor } from "../../shared/presets";
import type { HivePublisherApi } from "../../shared/publisher-api";
import { PublisherClient } from "../../web/publisher-client";
import { CaptureManager } from "./capture-manager";
import { openWebcam, openWindow } from "./openers";

const params = new URLSearchParams(location.search);
const port = params.get("port") ?? "7420";
const token = params.get("token") ?? "";
const api: HivePublisherApi = window.hivePublisher;

let sources: SourceConfig[] = [];

const client = new PublisherClient({
  url: `ws://127.0.0.1:${port}/local/publisher?token=${encodeURIComponent(token)}`,
  acquire: (id) => captures.acquire(id),
  release: (id) => captures.release(id),
  encodingFor: (id) => {
    const s = sources.find((x) => x.id === id);
    return s ? encodingFor(s.preset, s.kind === "spout") : null;
  },
});

const captures = new CaptureManager({
  openers: { window: openWindow, webcam: openWebcam },
  onStatus: (id, status) => client.reportStatus(id, status),
  onEnded: (id) => client.endSource(id),
});

sources = await api.getSources();
captures.setSources(sources);
api.onSourcesChanged((next) => {
  sources = next;
  captures.setSources(next);
});
client.start();
