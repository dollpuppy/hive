import { AlphaUnpacker } from "../../web/alpha/alpha-unpacker";
import { ViewerClient } from "../../web/viewer-client";

interface Preview {
  el: HTMLDivElement;
  client: ViewerClient;
  stopLoop(): void;
  /** Releases the WebGL context (if any) and detaches the stream. Only for a preview being discarded. */
  dispose(): void;
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
        // Chromium caps concurrent WebGL contexts (~16); AlphaUnpacker's constructor can throw
        // "WebGL unavailable" once that cap (or a driver limit) is hit. Fall back to the packed
        // video as-is rather than losing the preview row entirely.
        if (info.alpha && (unpacker ??= tryCreateUnpacker())) {
          video.className = "feeder";
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

    function tryCreateUnpacker(): AlphaUnpacker | null {
      try {
        return new AlphaUnpacker(canvas);
      } catch (err) {
        console.error("[hive] AlphaUnpacker unavailable, showing the packed video without alpha", err);
        return null;
      }
    }

    const dispose = (): void => {
      stopLoop();
      unpacker?.dispose();
      unpacker = null;
      video.srcObject = null;
    };

    if (!this.paused) client.start();
    this.previews.set(key, { el, client, stopLoop, dispose });
    return el;
  }

  /** Stop and fully release previews that are no longer rendered (closes their WebGL context, if any). */
  retain(keys: ReadonlySet<string>): void {
    for (const [key, p] of [...this.previews]) {
      if (keys.has(key)) continue;
      p.client.stop();
      p.dispose();
      this.previews.delete(key);
    }
  }
}
