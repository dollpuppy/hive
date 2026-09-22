/** Outbound half of a connection. Implementations serialize to JSON. */
export interface Channel {
  send(message: object): void;
  close(code?: number, reason?: string): void;
}

/** Inbound half: the transport calls these. Both must be idempotent-safe. */
export interface ChannelHandler {
  onMessage(raw: string): void;
  onClose(): void;
}
