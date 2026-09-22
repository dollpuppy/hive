import type { SourceConfig } from "../main/config/config-store";

/** Exposed by src/preload/publisher.ts on window.hivePublisher. */
export interface HivePublisherApi {
  getSources(): Promise<SourceConfig[]>;
  /** Returns a function that removes the listener. */
  onSourcesChanged(listener: (sources: SourceConfig[]) => void): () => void;
  /** Tell main which window the next getDisplayMedia() call should capture. */
  selectWindow(title: string): Promise<void>;
}

declare global {
  interface Window {
    hivePublisher: HivePublisherApi;
  }
}
