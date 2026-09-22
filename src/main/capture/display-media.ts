import {
  desktopCapturer,
  ipcMain,
  session,
  webContents as WebContentsStatic,
  type DesktopCapturerSource,
  type IpcMainInvokeEvent,
  type Streams,
  type WebContents,
  type WebFrameMain,
} from "electron";

/**
 * How long a window selection stays valid. Matches the Publisher's per-open timeout
 * (OPEN_WINDOW_TIMEOUT_MS in src/renderer/publisher/openers.ts), so a selection whose
 * getDisplayMedia() never came can't grant a later, unrelated request.
 */
const SELECTION_TTL_MS = 10_000;

const MAX_TITLE_CHARS = 1024;

/** True when `frame` is the Publisher's top-level frame. */
function isPublisherMainFrame(publisher: WebContents, frame: WebFrameMain | null): boolean {
  if (!frame || publisher.isDestroyed()) return false;
  return frame.parent === null && WebContentsStatic.fromFrame(frame) === publisher;
}

/** True when an IPC invoke came from the Publisher's top-level frame. */
export function isFromPublisher(publisher: WebContents, event: IpcMainInvokeEvent): boolean {
  return !publisher.isDestroyed() && event.sender === publisher && isPublisherMainFrame(publisher, event.senderFrame);
}

async function findSource(title: string): Promise<DesktopCapturerSource | undefined> {
  const noThumb = { width: 0, height: 0 };
  const windows = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: noThumb });
  const win = windows.find((s) => s.name === title);
  if (win) return win;
  const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: noThumb });
  return screens.find((s) => s.name === title);
}

/**
 * Grants getDisplayMedia() from the Publisher to the window whose title was
 * selected just before the call (openers serialize these calls). Every other
 * display-media request, and select-window IPC from anywhere else, is denied.
 */
export function installDisplayMediaHandler(publisher: WebContents): void {
  let pending: { title: string; expires: number } | null = null;

  ipcMain.handle("hive:publisher:select-window", (event, title: unknown) => {
    if (!isFromPublisher(publisher, event)) throw new Error("forbidden");
    if (typeof title !== "string" || title === "" || title.length > MAX_TITLE_CHARS) throw new Error("invalid title");
    pending = { title, expires: Date.now() + SELECTION_TTL_MS };
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    let answered = false;
    const answer = (streams: Streams | null): void => {
      if (answered) return;
      answered = true;
      try {
        // Electron's docs deny with callback(null); its typings only admit Streams.
        callback(streams as Streams);
      } catch (err) {
        console.error("[hive] display-media callback failed:", err);
      }
    };

    // Other pages' requests are denied without touching the selection, so they can't
    // cancel an open the Publisher has in flight.
    if (!isPublisherMainFrame(publisher, request.frame)) return answer(null);
    const selection = pending;
    pending = null;
    if (!request.videoRequested) return answer(null);
    if (!selection || Date.now() > selection.expires) return answer(null);

    // Windows first: a window titled like a screen ("Screen 1") must not lose to the screen.
    // Screens are only a fallback, for sources whose title names a whole display.
    findSource(selection.title)
      .then((match) => answer(match ? { video: { id: match.id, name: match.name } } : null))
      .catch((err: unknown) => {
        console.error("[hive] desktopCapturer.getSources failed:", err);
        answer(null);
      });
  });
}

/** For the dashboard's window picker (Plan 4). */
export async function listCapturableWindows(): Promise<{ title: string; thumbnail: string }[]> {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 192, height: 108 },
  });
  return sources.map((s) => ({ title: s.name, thumbnail: s.thumbnail.toDataURL() }));
}
