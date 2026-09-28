import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../src/main/config/config-store";
import type { CaptureError as CaptureErrorType } from "../../src/renderer/publisher/capture-manager";

type Openers = typeof import("../../src/renderer/publisher/openers");

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}

const win = (title: string): SourceConfig => ({ id: title, name: title, slug: title, preset: "med", kind: "window", windowTitle: title });
const cam: SourceConfig = { id: "c", name: "Cam", slug: "cam", preset: "low", kind: "webcam", deviceId: "d1", deviceLabel: "Logi" };

/** Let queued promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let openers: Openers;
/** Re-imported with openers after resetModules, so instanceof checks use the same class. */
let CaptureError: typeof CaptureErrorType;
let events: string[];
let selectWindow: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let displays: Deferred<MediaStream>[];

beforeEach(async () => {
  events = [];
  displays = [];
  selectWindow = vi.fn(async (title: string) => {
    events.push(`select ${title}`);
  });
  getDisplayMedia = vi.fn(() => {
    events.push("gdm");
    const d = deferred<MediaStream>();
    displays.push(d);
    return d.promise;
  });
  getUserMedia = vi.fn();
  // Default: the publisher's own device list contains the stored deviceId, matching real behaviour
  // (same-origin windows agree on salted ids) unless a test overrides it.
  enumerateDevices = vi.fn(async () => [{ deviceId: "d1", label: "Logi", kind: "videoinput" } as MediaDeviceInfo]);
  vi.stubGlobal("window", { hivePublisher: { selectWindow, getSources: vi.fn(), onSourcesChanged: vi.fn() } });
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia, enumerateDevices } });
  vi.resetModules(); // fresh displayQueue per test
  openers = await import("../../src/renderer/publisher/openers");
  ({ CaptureError } = await import("../../src/renderer/publisher/capture-manager"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openWindow", () => {
  it("serializes: the next window is not selected until the previous capture settles", async () => {
    const a = openers.openWindow(win("A"));
    const b = openers.openWindow(win("B"));
    await flush();
    expect(events).toEqual(["select A", "gdm"]);
    const s = fakeStream();
    displays[0]!.resolve(s.stream);
    await expect(a).resolves.toEqual({ stream: s.stream });
    await flush();
    expect(events).toEqual(["select A", "gdm", "select B", "gdm"]);
    displays[1]!.resolve(fakeStream().stream);
    await b;
  });

  it("passes the preset as max constraints", async () => {
    const a = openers.openWindow(win("A"));
    await flush();
    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
    });
    displays[0]!.resolve(fakeStream().stream);
    await a;
  });

  it("maps getDisplayMedia failure to CaptureError unavailable and keeps the queue moving", async () => {
    const a = openers.openWindow(win("A"));
    const b = openers.openWindow(win("B"));
    await flush();
    displays[0]!.reject(new DOMException("denied", "NotAllowedError"));
    const err = await a.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ status: "unavailable", message: 'window "A" not found' });
    await flush();
    expect(events.at(-2)).toBe("select B");
    displays[1]!.resolve(fakeStream().stream);
    await expect(b).resolves.toBeDefined();
  });

  it("maps selectWindow failure to CaptureError with the cause", async () => {
    selectWindow.mockRejectedValueOnce(new Error("ipc down"));
    const err = await openers.openWindow(win("A")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureErrorType).message).toContain("ipc down");
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("times out a hung open, advances the queue, and stops a late capture", async () => {
    vi.useFakeTimers();
    const a = openers.openWindow(win("A"));
    const b = openers.openWindow(win("B"));
    const aErr = a.catch((e: unknown) => e);
    await flush();
    expect(events).toEqual(["select A", "gdm"]);
    await vi.advanceTimersByTimeAsync(openers.OPEN_WINDOW_TIMEOUT_MS);
    const err = await aErr;
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureErrorType).message).toContain("timed out opening window");
    await flush();
    expect(events).toEqual(["select A", "gdm", "select B", "gdm"]);
    // The hung call finally answers: its tracks must not leak.
    const late = fakeStream();
    displays[0]!.resolve(late.stream);
    await flush();
    expect(late.track.stopped).toBe(true);
    const s = fakeStream();
    displays[1]!.resolve(s.stream);
    await expect(b).resolves.toEqual({ stream: s.stream });
    expect(s.track.stopped).toBe(false);
  });

  it("skips getDisplayMedia when selectWindow answers after the timeout", async () => {
    vi.useFakeTimers();
    const hung = deferred<void>();
    selectWindow.mockImplementationOnce(async (title: string) => {
      events.push(`select ${title}`);
      await hung.promise;
    });
    const a = openers.openWindow(win("A"));
    const aErr = a.catch((e: unknown) => e);
    const b = openers.openWindow(win("B"));
    await flush();
    expect(events).toEqual(["select A"]);
    await vi.advanceTimersByTimeAsync(openers.OPEN_WINDOW_TIMEOUT_MS);
    expect((await aErr as CaptureErrorType).message).toContain("timed out opening window");
    await flush();
    expect(events).toEqual(["select A", "select B", "gdm"]);
    // A's select finally returns while B is waiting on its grant: A must not call getDisplayMedia.
    hung.resolve();
    await flush();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    const s = fakeStream();
    displays[0]!.resolve(s.stream);
    await expect(b).resolves.toEqual({ stream: s.stream });
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it("rejects non-window sources", async () => {
    await expect(openers.openWindow(cam)).rejects.toThrow("not a window source");
  });
});

describe("openWebcam", () => {
  it("opens the exact device with preset constraints", async () => {
    const s = fakeStream();
    getUserMedia.mockResolvedValueOnce(s.stream);
    await expect(openers.openWebcam(cam)).resolves.toEqual({ stream: s.stream });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { deviceId: { exact: "d1" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  });

  it("maps failure to CaptureError with the OBS hint", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    const err = await openers.openWebcam(cam).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ status: "unavailable" });
    expect((err as CaptureErrorType).message).toContain('webcam "Logi"');
    expect((err as CaptureErrorType).message).toContain("in use by OBS?");
  });

  it("re-resolves by exact label when the stored deviceId isn't valid in this origin", async () => {
    // The dashboard (a different origin) picked "d1"; the publisher's own salted id differs.
    enumerateDevices.mockResolvedValueOnce([{ deviceId: "publisher-salted-id", label: "Logi", kind: "videoinput" } as MediaDeviceInfo]);
    const s = fakeStream();
    getUserMedia.mockResolvedValueOnce(s.stream);
    await expect(openers.openWebcam(cam)).resolves.toEqual({ stream: s.stream });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { deviceId: { exact: "publisher-salted-id" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  });

  it("keeps the stored deviceId when enumerateDevices fails", async () => {
    enumerateDevices.mockRejectedValueOnce(new Error("permission denied"));
    const s = fakeStream();
    getUserMedia.mockResolvedValueOnce(s.stream);
    await expect(openers.openWebcam(cam)).resolves.toEqual({ stream: s.stream });
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ deviceId: { exact: "d1" } }) }),
    );
  });

  it("fails as before when neither the stored deviceId nor label match any device", async () => {
    enumerateDevices.mockResolvedValueOnce([{ deviceId: "other-id", label: "Other Cam", kind: "videoinput" } as MediaDeviceInfo]);
    getUserMedia.mockRejectedValueOnce(new DOMException("not found", "OverconstrainedError"));
    const err = await openers.openWebcam(cam).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toMatchObject({ status: "unavailable" });
    // Falls through to the stored (now stale) deviceId, which getUserMedia then rejects.
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ deviceId: { exact: "d1" } }) }),
    );
  });
});
