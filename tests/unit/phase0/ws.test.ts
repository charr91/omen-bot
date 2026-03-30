import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMarketWsCapture } from '../../../src/phase0/ws.js';

type Listener = (event?: { data?: unknown }) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<{ listener: Listener; once: boolean }>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.emit('open');
      }
    });
  }

  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void {
    const once = typeof options === 'object' && options !== null ? options.once === true : false;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }

    this.listeners.set(
      type,
      listeners.filter((entry) => entry.listener !== listener),
    );
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('MockWebSocket is not open');
    }

    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }

    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }

  simulateServerClose(): void {
    this.close();
  }

  simulateMessage(data: unknown): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const entry of listeners) {
      if (entry.once) {
        this.removeEventListener(type, entry.listener);
      }
      entry.listener(event);
    }
  }
}

describe('phase0 websocket capture', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('sends periodic PING heartbeats while the connection is open', async () => {
    const controller = await startMarketWsCapture({
      onMessage: async () => undefined,
    });
    const socket = MockWebSocket.instances[0];

    expect(socket).toBeDefined();

    await controller.subscribe(['asset-1']);
    expect(socket?.sent[0]).toContain('"assets_ids":["asset-1"]');

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(socket?.sent.filter((message) => message === 'PING')).toHaveLength(2);

    await controller.stop();
    const pingCountAfterStop = socket?.sent.filter((message) => message === 'PING').length ?? 0;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket?.sent.filter((message) => message === 'PING')).toHaveLength(pingCountAfterStop);
  });

  it('reconnects and resubscribes desired assets after the socket closes', async () => {
    const controller = await startMarketWsCapture({
      onMessage: async () => undefined,
    });
    const firstSocket = MockWebSocket.instances[0];

    await controller.subscribe(['asset-1']);
    firstSocket?.simulateServerClose();

    await controller.subscribe(['asset-2']);

    expect(MockWebSocket.instances).toHaveLength(2);
    const secondSocket = MockWebSocket.instances[1];
    expect(secondSocket?.sent[0]).toContain('"assets_ids":["asset-1","asset-2"]');

    await controller.stop();
  });

  it('routes async message handler failures to onError instead of leaving them unhandled', async () => {
    const onError = vi.fn(async () => undefined);
    const controller = await startMarketWsCapture({
      onMessage: async () => {
        throw new Error('boom');
      },
      onError,
    });
    const socket = MockWebSocket.instances[0];

    socket?.simulateMessage(JSON.stringify({ asset_id: 'asset-1', timestamp: '1' }));
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });

    expect(onError.mock.calls[0]?.[1]).toBe('websocket message');

    await controller.stop();
  });
});
