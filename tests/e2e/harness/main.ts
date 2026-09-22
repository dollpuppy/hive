import { contentHintFor } from "../../../src/shared/presets";
import { PublisherClient } from "../../../src/web/publisher-client";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let frame = 0;
setInterval(() => {
  frame++;
  ctx.fillStyle = `hsl(${frame % 360} 80% 50%)`;
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = "#fff";
  ctx.font = "48px sans-serif";
  ctx.fillText(String(frame), 40, 200);
}, 33);
const stream = canvas.captureStream(30);
// Match the real capture manager for a "window" source ("detail" keeps full resolution while the
// bandwidth estimate ramps up; without it the encoder starts at 320x180 and scales up over seconds).
for (const track of stream.getVideoTracks()) track.contentHint = contentHintFor("window");

const token = new URLSearchParams(location.search).get("token") ?? "";
let refs = 0;
const acquired: string[] = [];
const client = new PublisherClient({
  url: `ws://${location.host}/local/publisher?token=${encodeURIComponent(token)}`,
  acquire: async (sourceId) => {
    acquired.push(sourceId);
    refs++;
    return stream;
  },
  release: () => {
    refs--;
  },
  // Like production: unknown source ids get no encoding, so the client refuses the subscription.
  encodingFor: (sourceId) => (sourceId === "src-game" ? { maxBitrate: 1_000_000, maxFramerate: 30 } : null),
});
// Like production (CaptureManager reports idle for every configured source): the Hub marks
// sources unavailable while no Publisher is connected, and this restores them on connect.
client.reportStatus("src-game", "idle");
client.start();
(window as unknown as { harness: { refs: () => number; acquired: () => string[] } }).harness = {
  refs: () => refs,
  acquired: () => [...acquired],
};
