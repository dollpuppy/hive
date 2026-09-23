import type { SourceConfig } from "../main/config/config-store";

/**
 * Exposed by src/preload/publisher.ts on window.hivePublisher.
 *
 * Spout/URL opens resolve a handle that the matching close passes back: main
 * ignores a close whose handle is not the source's current open, so a late close
 * from a superseded open (torn down while still opening) cannot kill its successor.
 * Main's IPC handlers for these opens/closes must act synchronously (no `await`
 * before calling SpoutInputs/UrlSources open/close) so they run in the order sent.
 */
export interface HivePublisherApi {
  getSources(): Promise<SourceConfig[]>;
  /** Returns a function that removes the listener. */
  onSourcesChanged(listener: (sources: SourceConfig[]) => void): () => void;
  /** Tell main which window the next getDisplayMedia() call should capture. */
  selectWindow(title: string): Promise<void>;
  /**
   * Start zero-copy delivery of a Spout sender, tagged with sourceId. Resolves the
   * open's handle; rejects if the sender is missing.
   */
  spoutOpen(sourceId: string, senderName: string): Promise<number>;
  /** Stop the open identified by `handle`; a no-op if the source was re-opened since. */
  spoutClose(sourceId: string, handle: number): Promise<void>;
  spoutSenders(): Promise<string[]>;
  /** Returns a function that removes the listener. */
  onSpoutAvailability(listener: (senderName: string, available: boolean) => void): () => void;
  /**
   * Start rendering a URL source offscreen and forwarding its frames, tagged with
   * sourceId. Resolves the open's handle; rejects only on invalid input/config.
   */
  urlOpen(sourceId: string): Promise<number>;
  /** Stop the open identified by `handle`; a no-op if the source was re-opened since. */
  urlClose(sourceId: string, handle: number): Promise<void>;
  /**
   * Main gave up on the URL-source open `handle` (repeated crashes or failed loads)
   * and destroyed its window. Returns a function that removes the listener.
   */
  onUrlFailed(listener: (sourceId: string, handle: number) => void): () => void;
}

/** Receives a GPU-backed VideoFrame. Use synchronously; never close it (the pool does). */
export type FrameSink = (frame: VideoFrame) => void;

export interface HiveFramesApi {
  /** Route frames tagged with sourceId to sink. Returns an unregister function. */
  register(sourceId: string, sink: FrameSink): () => void;
}

declare global {
  interface Window {
    hivePublisher: HivePublisherApi;
    hiveFrames: HiveFramesApi;
  }
}
