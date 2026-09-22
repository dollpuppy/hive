import { ViewerClient } from "../web/viewer-client";

const video = document.getElementById("stage") as HTMLVideoElement;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const [, , peerSegment = "", sourceSegment = ""] = location.pathname.split("/");
if (new URLSearchParams(location.search).get("fit") === "cover") document.body.classList.add("cover");

const client = new ViewerClient({
  url: `ws://${location.host}/local/viewer`,
  peer: decodeSegment(peerSegment),
  source: decodeSegment(sourceSegment),
  onStream: (stream) => {
    video.srcObject = stream;
    video.hidden = false;
    void video.play().catch(() => undefined);
  },
  onIdle: () => {
    video.srcObject = null;
    video.hidden = true;
  },
});
client.start();
window.addEventListener("beforeunload", () => client.stop());
