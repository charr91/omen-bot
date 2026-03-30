import {
  MARKET_WS_HEARTBEAT_INTERVAL_MS,
  POLYMARKET_MARKET_WS_URL,
  WS_SUBSCRIPTION_BATCH_SIZE,
} from './constants.js';
import { isJsonObject } from './json.js';
import type { JsonObject } from './types.js';

interface WsCaptureOptions {
  onMessage: (message: JsonObject) => Promise<void>;
  onError?: (error: unknown, label: string) => Promise<void> | void;
}

export interface WsCaptureController {
  subscribe(assetIds: string[]): Promise<void>;
  stop(): Promise<void>;
}

export async function startMarketWsCapture(options: WsCaptureOptions): Promise<WsCaptureController> {
  const desiredAssetIds = new Set<string>();
  let ws: WebSocket | null = null;
  let subscribedAssetIds = new Set<string>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let openSocketPromise: Promise<WebSocket> | null = null;
  let stopped = false;

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(socket: WebSocket): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (stopped || ws !== socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send('PING');
    }, MARKET_WS_HEARTBEAT_INTERVAL_MS);

    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }

  function attachSocket(socket: WebSocket): void {
    socket.addEventListener('message', (event) => {
      void handleIncomingMessage(event.data, options.onMessage).catch((error) => {
        if (options.onError) {
          try {
            const result = options.onError(error, 'websocket message');
            if (result && typeof result === 'object' && 'catch' in result) {
              void (result as Promise<void>).catch((nestedError) => {
                reportUnhandledWsError(nestedError, 'websocket error handler');
              });
            }
          } catch (nestedError) {
            reportUnhandledWsError(nestedError, 'websocket error handler');
          }
          return;
        }

        reportUnhandledWsError(error, 'websocket message');
      });
    });
    socket.addEventListener('close', () => {
      if (ws === socket) {
        ws = null;
        subscribedAssetIds = new Set<string>();
      }
      if (openSocketPromise !== null) {
        openSocketPromise = null;
      }
      clearHeartbeat();
    });
  }

  async function openSocket(): Promise<WebSocket> {
    const socket = new WebSocket(POLYMARKET_MARKET_WS_URL);
    attachSocket(socket);

    await new Promise<void>((resolve, reject) => {
      const handleOpen = (): void => {
        socket.removeEventListener('error', handleError);
        socket.removeEventListener('close', handleClose);
        resolve();
      };
      const handleError = (): void => {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('close', handleClose);
        reject(new Error('Failed to connect to Polymarket market WebSocket'));
      };
      const handleClose = (): void => {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('error', handleError);
        reject(new Error('Polymarket market WebSocket closed before it finished opening'));
      };

      socket.addEventListener('open', handleOpen, { once: true });
      socket.addEventListener('error', handleError, { once: true });
      socket.addEventListener('close', handleClose, { once: true });
    });

    ws = socket;
    startHeartbeat(socket);
    return socket;
  }

  async function ensureOpenSocket(): Promise<WebSocket> {
    if (stopped) {
      throw new Error('Polymarket market WebSocket capture has already been stopped');
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      return ws;
    }

    if (openSocketPromise === null) {
      openSocketPromise = openSocket().finally(() => {
        openSocketPromise = null;
      });
    }

    return openSocketPromise;
  }

  await ensureOpenSocket();

  return {
    async subscribe(assetIds: string[]): Promise<void> {
      for (const assetId of assetIds) {
        desiredAssetIds.add(assetId);
      }

      const socket = await ensureOpenSocket();
      const pendingAssetIds = [...desiredAssetIds].filter((assetId) => !subscribedAssetIds.has(assetId));
      if (pendingAssetIds.length === 0) {
        return;
      }

      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error('Polymarket market WebSocket is not open for subscriptions');
      }

      for (let index = 0; index < pendingAssetIds.length; index += WS_SUBSCRIPTION_BATCH_SIZE) {
        const chunk = pendingAssetIds.slice(index, index + WS_SUBSCRIPTION_BATCH_SIZE);
        socket.send(
          JSON.stringify({
            type: 'MARKET',
            assets_ids: chunk,
          }),
        );
      }

      for (const assetId of pendingAssetIds) {
        subscribedAssetIds.add(assetId);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      clearHeartbeat();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000, 'phase0 capture complete');
      }
      ws = null;
      subscribedAssetIds = new Set<string>();
    },
  };
}

function reportUnhandledWsError(error: unknown, label: string): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[phase0] ${label} failed: ${message}\n`);
}

async function handleIncomingMessage(
  rawMessage: string | ArrayBuffer | Blob,
  onMessage: (message: JsonObject) => Promise<void>,
): Promise<void> {
  const text = await readWsPayload(rawMessage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return;
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (isJsonObject(entry)) {
        await onMessage(entry);
      }
    }
    return;
  }

  if (isJsonObject(parsed)) {
    await onMessage(parsed);
  }
}

async function readWsPayload(rawMessage: string | ArrayBuffer | Blob): Promise<string> {
  if (typeof rawMessage === 'string') {
    return rawMessage;
  }

  if (rawMessage instanceof ArrayBuffer) {
    return Buffer.from(rawMessage).toString('utf8');
  }

  return rawMessage.text();
}
