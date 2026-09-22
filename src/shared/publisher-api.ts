import type { SourceConfig } from "../main/config/config-store";

/** Exposed by src/preload/publisher.ts on window.hivePublisher. */
export interface HivePublisherApi {
  getSources(): Promise<SourceConfig[]>;
  /** Returns a function that removes the listener. */
  onSourcesChanged(listener: (sources: SourceConfig[]) => void): () => void;
  /** Tell main which window the next getDisplayMedia() call should capture. */
  selectWindow(title: string): Promise<void>;
  /** Start zero-copy delivery of a Spout sender, tagged with sourceId. Rejects if the sender is missing. */
  spoutOpen(sourceId: string, senderName: string): Promise<void>;
  spoutClose(sourceId: string): Promise<void>;
  spoutSenders(): Promise<string[]>;
  /** Returns a function that removes the listener. */
  onSpoutAvailability(listener: (senderName: string, available: boolean) => void): () => void;
  /** Start rendering a URL source offscreen and forwarding its frames, tagged with sourceId. */
  urlOpen(sourceId: string): Promise<void>;
  urlClose(sourceId: string): Promise<void>;
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
