import { AlphaUnpacker } from "../web/alpha/alpha-unpacker";
import { ViewerClient } from "../web/viewer-client";

const video = document.getElementById("stage") as HTMLVideoElement;
const canvas = document.getElementById("alpha") as HTMLCanvasElement;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const [, , peerSegment = "", sourceSegment = ""] = location.pathname.split("/");
const params = new URLSearchParams(location.search);
if (params.get("fit") === "cover") document.body.classList.add("cover");

let unpacker: AlphaUnpacker | null = null;
let unpackerFailed = false;

// Unpack once per decoded video frame when the browser can tell us about them;
// otherwise once per display refresh.
const hasVideoFrameCallback = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
/** Cancels the pending callback of the running loop; a no-op when stopped. */
let cancelLoop = (): void => {};

function startAlphaLoop(): void {
  if (unpackerFailed) return;
  if (!unpacker) {
    try {
      unpacker = new AlphaUnpacker(canvas, { srcPremultiplied: params.get("premultiplied") === "1" });
    } catch (err) {
      unpackerFailed = true;
      console.error("AlphaUnpacker unavailable; falling back to opaque video", err);
      video.classList.remove("feeder");
      canvas.hidden = true;
      return;
    }
  }
  cancelLoop();
  const draw = (): void => {
    if (video.readyState >= video.HAVE_CURRENT_DATA) {
      unpacker?.draw(video, video.videoWidth, video.videoHeight);
    }
  };
  if (hasVideoFrameCallback) {
    let id = 0;
    const tick = (): void => {
      try {
        draw();
      } finally {
        id = video.requestVideoFrameCallback(tick);
      }
    };
    id = video.requestVideoFrameCallback(tick);
    cancelLoop = () => video.cancelVideoFrameCallback(id);
  } else {
    let id = 0;
    const tick = (): void => {
      try {
        draw();
      } finally {
        id = requestAnimationFrame(tick);
      }
    };
    id = requestAnimationFrame(tick);
    cancelLoop = () => cancelAnimationFrame(id);
  }
}

function stopAlphaLoop(): void {
  cancelLoop();
  cancelLoop = () => {};
  unpacker?.clear();
}

const client = new ViewerClient({
  url: `ws://${location.host}/local/viewer`,
  peer: decodeSegment(peerSegment),
  source: decodeSegment(sourceSegment),
  onStream: (stream, info) => {
    video.srcObject = stream;
    video.hidden = false;
    void video.play().catch(() => undefined);
    if (info.alpha) {
      video.classList.add("feeder");
      canvas.hidden = false;
      startAlphaLoop();
    } else {
      video.classList.remove("feeder");
      canvas.hidden = true;
      stopAlphaLoop();
    }
  },
  onIdle: () => {
    stopAlphaLoop();
    video.srcObject = null;
    video.hidden = true;
    canvas.hidden = true;
  },
});
client.start();
window.addEventListener("beforeunload", () => client.stop());
