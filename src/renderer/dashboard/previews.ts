import { AlphaUnpacker } from "../../web/alpha/alpha-unpacker";
import { ViewerClient } from "../../web/viewer-client";

interface Preview {
  el: HTMLDivElement;
  client: ViewerClient;
  stopLoop(): void;
}

/**
 * Live thumbnails. One ViewerClient per (peer, source), reused across re-renders.
 * Each preview is a real subscriber, so all of them pause while the window is hidden.
 */
export class PreviewPool {
  private readonly previews = new Map<string, Preview>();
  private paused = document.visibilityState === "hidden";

  constructor(private readonly port: () => number) {
    document.addEventListener("visibilitychange", () => {
      this.paused = document.visibilityState === "hidden";
      for (const p of this.previews.values()) {
        if (this.paused) {
          p.client.stop();
          p.stopLoop();
        } else {
          p.client.start();
        }
      }
    });
  }

  get(peer: string, slug: string): HTMLDivElement {
    const key = `${peer}/${slug}`;
    const existing = this.previews.get(key);
    if (existing) return existing.el;

    const el = document.createElement("div");
    el.className = "thumb";
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    let unpacker: AlphaUnpacker | null = null;
    let raf = 0;
    const stopLoop = (): void => cancelAnimationFrame(raf);

    const client = new ViewerClient({
      url: `ws://127.0.0.1:${this.port()}/local/viewer`,
      peer,
      source: slug,
      onStream: (stream, info) => {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
        stopLoop();
        if (info.alpha) {
          video.className = "feeder";
          unpacker ??= new AlphaUnpacker(canvas);
          el.replaceChildren(video, canvas);
          const tick = (): void => {
            try {
              unpacker?.draw(video, video.videoWidth, video.videoHeight);
            } finally {
              raf = requestAnimationFrame(tick);
            }
          };
          raf = requestAnimationFrame(tick);
        } else {
          video.className = "";
          el.replaceChildren(video);
        }
      },
      onIdle: () => {
        stopLoop();
        video.srcObject = null;
        el.replaceChildren();
      },
    });
    if (!this.paused) client.start();
    this.previews.set(key, { el, client, stopLoop });
    return el;
  }

  /** Stop previews that are no longer rendered. */
  retain(keys: ReadonlySet<string>): void {
    for (const [key, p] of [...this.previews]) {
      if (keys.has(key)) continue;
      p.client.stop();
      p.stopLoop();
      this.previews.delete(key);
    }
  }
}
