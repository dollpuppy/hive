import type { Channel, ChannelHandler } from "../../../src/main/hub/channel";
import type { Hub } from "../../../src/main/hub/hub";
import type { SourceInfo } from "../../../src/shared/protocol";

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

/** Records everything sent to it; used for viewers and publishers. */
export class FakeChannel implements Channel {
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(message: object): void {
    this.sent.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  ofType(type: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === type);
  }
  last(type: string): Record<string, unknown> | undefined {
    return this.ofType(type).at(-1);
  }
}

/** Wires two hubs together with async (microtask) delivery, like a socket. */
export function connectHubs(host: Hub, joiner: Hub, secret: string): { close(): void } {
  let hostSide: ChannelHandler | undefined;
  let joinerSide: ChannelHandler | undefined;
  let open = true;
  const shutdown = (): void => {
    if (!open) return;
    open = false;
    queueMicrotask(() => {
      hostSide?.onClose();
      joinerSide?.onClose();
    });
  };
  const toJoiner: Channel = {
    send: (m) => {
      const raw = JSON.stringify(m);
      if (open) queueMicrotask(() => joinerSide?.onMessage(raw));
    },
    close: shutdown,
  };
  const toHost: Channel = {
    send: (m) => {
      const raw = JSON.stringify(m);
      if (open) queueMicrotask(() => hostSide?.onMessage(raw));
    },
    close: shutdown,
  };
  hostSide = host.attachIncomingPeer(toJoiner);
  joinerSide = joiner.attachOutgoingPeer(toHost, secret);
  return { close: shutdown };
}

export function source(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    id: "src-game",
    name: "Game",
    slug: "game",
    kind: "window",
    alpha: false,
    width: 1920,
    height: 1080,
    fps: 30,
    status: "idle",
    ...overrides,
  };
}
