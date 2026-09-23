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

/** How long a canvas may go without a draw before its last frame is re-sent. */
export const IDLE_REFRESH_MS = 1000;

function canRequestFrame(track: MediaStreamTrack): track is CanvasCaptureMediaStreamTrack {
  return typeof (track as Partial<CanvasCaptureMediaStreamTrack>).requestFrame === "function";
}

/**
 * `captureStream()` (called with no frame rate) only emits a frame when the canvas is
 * actually painted to, so a paused Spout sender or a static page would leave late
 * joiners (and the encoder) with nothing. While no draw has happened for about
 * IDLE_REFRESH_MS, `redraw()` re-paints the canvas's own unchanged contents so the
 * browser sees a dirty canvas and captures a frame from it on its own. `requestFrame()`
 * is also called: per spec it should force a capture regardless, but in practice
 * Chromium only honors it right after the canvas was actually modified, i.e. right
 * after `redraw()` — so it's kept as a (likely redundant, essentially free) nudge.
 */
function idleRefresher(redraw: () => void): { drew(): void; start(stream: MediaStream): void; stop(): void } {
  let lastDraw = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    drew: () => {
      lastDraw = performance.now();
    },
    start: (stream) => {
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      timer = setInterval(() => {
        if (performance.now() - lastDraw < IDLE_REFRESH_MS * 0.9) return;
        redraw();
        if (canRequestFrame(track)) track.requestFrame();
      }, IDLE_REFRESH_MS);
    },
    stop: () => clearInterval(timer),
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
    // Preserved so requestFrame() re-sends the last packed frame, not a cleared buffer.
    packer = new AlphaPacker(spec.width, spec.height, { preserveDrawingBuffer: true });
  } catch (err) {
    throw new CaptureError("unavailable", `could not create alpha packer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const due = throttle(spec.fps);
  const idle = idleRefresher(() => packer.redraw());
  const unregister = window.hiveFrames.register(source.id, (frame) => {
    if (!due()) return;
    packer.draw(frame, frame.displayWidth, frame.displayHeight);
    idle.drew();
  });
  let handle: number;
  try {
    handle = await window.hivePublisher.spoutOpen(source.id, source.senderName);
  } catch {
    unregister();
    packer.dispose();
    throw new CaptureError("waiting", `Spout sender "${source.senderName}" not found`);
  }
  // No frame rate: one frame per draw (already throttled), plus idle refreshes.
  const stream = packer.canvas.captureStream();
  idle.start(stream);
  return {
    stream,
    dispose: () => {
      idle.stop();
      unregister();
      window.hivePublisher.spoutClose(source.id, handle).catch((err: unknown) => {
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
  // Re-paints the canvas onto itself: same pixels, but a "dirty canvas" as far as
  // captureStream() is concerned.
  const idle = idleRefresher(() => ctx.drawImage(canvas, 0, 0));
  const unregister = window.hiveFrames.register(source.id, (frame) => {
    if (!due()) return;
    const r = containRect(frame.displayWidth, frame.displayHeight, source.width, source.height);
    ctx.fillRect(0, 0, source.width, source.height);
    ctx.drawImage(frame, r.x, r.y, r.w, r.h);
    idle.drew();
  });
  let handle: number;
  try {
    handle = await window.hivePublisher.urlOpen(source.id);
  } catch (err) {
    // urlOpen only rejects on invalid input/config; page load failures are retried in main.
    unregister();
    const reason = err instanceof Error ? err.message : String(err);
    throw new CaptureError("unavailable", `URL source "${source.name}" could not be opened: ${reason}`);
  }
  // No frame rate: one frame per draw (already throttled), plus idle refreshes.
  const stream = canvas.captureStream();
  idle.start(stream);
  return {
    stream,
    dispose: () => {
      idle.stop();
      unregister();
      window.hivePublisher.urlClose(source.id, handle).catch((err: unknown) => {
        console.error("[hive] urlClose failed", source.id, err);
      });
    },
  };
};
