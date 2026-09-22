import type { SourceConfig } from "../../main/config/config-store";
import { PRESETS } from "../../shared/presets";
import { CaptureError, type Capture, type Opener } from "./capture-manager";

// getDisplayMedia calls are serialized: main grants the window selected just before each call.
let displayQueue: Promise<unknown> = Promise.resolve();

export const openWindow: Opener = (source: SourceConfig) => {
  if (source.kind !== "window") return Promise.reject(new Error("not a window source"));
  const spec = PRESETS[source.preset];
  const run = async (): Promise<Capture> => {
    await window.hivePublisher.selectWindow(source.windowTitle);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { width: { max: spec.width }, height: { max: spec.height }, frameRate: { max: spec.fps } },
      });
      return { stream };
    } catch {
      throw new CaptureError("unavailable", `window "${source.windowTitle}" not found`);
    }
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
