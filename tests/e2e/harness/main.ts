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

const token = new URLSearchParams(location.search).get("token") ?? "";
let refs = 0;
const client = new PublisherClient({
  url: `ws://${location.host}/local/publisher?token=${encodeURIComponent(token)}`,
  acquire: async () => {
    refs++;
    return stream;
  },
  release: () => {
    refs--;
  },
  encodingFor: () => ({ maxBitrate: 1_000_000, maxFramerate: 30 }),
});
client.start();
(window as unknown as { harness: { refs: () => number } }).harness = { refs: () => refs };
