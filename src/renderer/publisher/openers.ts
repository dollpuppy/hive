import type { SourceConfig } from "../../main/config/config-store";
import { PRESETS } from "../../shared/presets";
import { CaptureError, type Capture, type Opener } from "./capture-manager";

/** How long one window open (selectWindow + getDisplayMedia) may take before it is abandoned. */
export const OPEN_WINDOW_TIMEOUT_MS = 10_000;

// getDisplayMedia calls are serialized: main grants the window selected just before each call.
// The queue advances when an open settles or times out, so one hung call cannot block the rest.
let displayQueue: Promise<unknown> = Promise.resolve();

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const openWindow: Opener = (source: SourceConfig) => {
  if (source.kind !== "window") return Promise.reject(new Error("not a window source"));
  const spec = PRESETS[source.preset];
  const title = source.windowTitle;

  const run = (): Promise<Capture> => {
    let timedOut = false;
    const attempt = (async (): Promise<Capture> => {
      try {
        await window.hivePublisher.selectWindow(title);
      } catch (err) {
        throw new CaptureError("unavailable", `could not select window "${title}": ${message(err)}`);
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: { width: { max: spec.width }, height: { max: spec.height }, frameRate: { max: spec.fps } },
        });
      } catch {
        throw new CaptureError("unavailable", `window "${title}" not found`);
      }
      if (timedOut) {
        // Nobody is waiting for this capture any more.
        stream.getTracks().forEach((t) => t.stop());
        throw new CaptureError("unavailable", `window "${title}" opened after the timeout`);
      }
      return { stream };
    })();
    // After a timeout nothing observes `attempt`; keep its late failure from going unhandled.
    attempt.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new CaptureError("unavailable", `timed out opening window "${title}"`));
      }, OPEN_WINDOW_TIMEOUT_MS);
    });
    return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
  };

  const result = displayQueue.then(run, run);
  displayQueue = result.catch(() => undefined);
  return result;
};

export const openWebcam: Opener = async (source: SourceConfig) => {
  if (source.kind !== "webcam") throw new Error("not a webcam source");
  const spec = PRESETS[source.preset];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: source.deviceId },
        width: { ideal: spec.width },
        height: { ideal: spec.height },
        frameRate: { ideal: spec.fps },
      },
    });
    return { stream };
  } catch {
    throw new CaptureError("unavailable", `webcam "${source.deviceLabel}" unavailable (in use by OBS?)`);
  }
};
