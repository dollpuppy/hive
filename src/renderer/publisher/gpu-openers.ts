import type { SourceConfig } from "../../main/config/config-store";
import { PRESETS } from "../../shared/presets";
import { AlphaPacker } from "../../web/alpha/alpha-packer";
import { containRect } from "../../web/alpha/contain-rect";
import { CaptureError, type Opener } from "./capture-manager";

/** Drops frames that arrive faster than the preset frame rate. */
function throttle(fps: number): () => boolean {
  const minGap = (1000 / fps) * 0.9;
  let last = -Infinity;
  return () => {
    const now = performance.now();
    if (now - last < minGap) return false;
    last = now;
    return true;
  };
}

/**
 * Spout capture: frames come from an external sender whose real size can differ from
 * (and change independently of) the source's configured preset. The preset's width/height
 * is treated as the fixed *output* size (also what SourceInfo advertises to viewers via
 * `sourceInfoFromConfig`); each incoming frame is letterboxed (with transparent bars) into
 * that size by the AlphaPacker/containRect combo rather than resizing the output to match
 * the sender. This keeps the advertised resolution stable across sender reconnects/resizes.
 */
export const openSpout: Opener = async (source: SourceConfig) => {
  if (source.kind !== "spout") throw new Error("not a spout source");
  const spec = PRESETS[source.preset];
  let packer: AlphaPacker;
  try {
    packer = new AlphaPacker(spec.width, spec.height);
  } catch (err) {
    throw new CaptureError("unavailable", `could not create alpha packer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const due = throttle(spec.fps);
  const unregister = window.hiveFrames.register(source.id, (frame) => {
    if (due()) packer.draw(frame, frame.displayWidth, frame.displayHeight);
  });
  try {
    await window.hivePublisher.spoutOpen(source.id, source.senderName);
  } catch {
    unregister();
    packer.dispose();
    throw new CaptureError("waiting", `Spout sender "${source.senderName}" not found`);
  }
  return {
    stream: packer.canvas.captureStream(spec.fps),
    dispose: () => {
      unregister();
      window.hivePublisher.spoutClose(source.id).catch((err: unknown) => {
        console.error("[hive] spoutClose failed", source.id, err);
      });
      packer.dispose();
    },
  };
};

export const openUrl: Opener = async (source: SourceConfig) => {
  if (source.kind !== "url") throw new Error("not a url source");
  const fps = PRESETS[source.preset].fps;
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new CaptureError("unavailable", "2D canvas unavailable");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, source.width, source.height);
  const due = throttle(fps);
  const unregister = window.hiveFrames.register(source.id, (frame) => {
    if (!due()) return;
    const r = containRect(frame.displayWidth, frame.displayHeight, source.width, source.height);
    ctx.fillRect(0, 0, source.width, source.height);
    ctx.drawImage(frame, r.x, r.y, r.w, r.h);
  });
  try {
    await window.hivePublisher.urlOpen(source.id);
  } catch {
    unregister();
    throw new CaptureError("unavailable", `could not load ${source.url}`);
  }
  return {
    stream: canvas.captureStream(fps),
    dispose: () => {
      unregister();
      window.hivePublisher.urlClose(source.id).catch((err: unknown) => {
        console.error("[hive] urlClose failed", source.id, err);
      });
    },
  };
};
