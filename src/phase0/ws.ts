import { POLYMARKET_MARKET_WS_URL, WS_SUBSCRIPTION_BATCH_SIZE } from './constants.js';
import { isJsonObject } from './json.js';
import type { JsonObject } from './types.js';

interface WsCaptureOptions {
  onMessage: (message: JsonObject) => Promise<void>;
}

export interface WsCaptureController {
  subscribe(assetIds: string[]): Promise<void>;
  stop(): Promise<void>;
}

export async function startMarketWsCapture(options: WsCaptureOptions): Promise<WsCaptureController> {
  const ws = new WebSocket(POLYMARKET_MARKET_WS_URL);
  const subscribedAssetIds = new Set<string>();
  const openPromise = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener(
      'error',
      () => reject(new Error('Failed to connect to Polymarket market WebSocket')),
      { once: true },
    );
  });

  ws.addEventListener('message', (event) => {
    void handleIncomingMessage(event.data, options.onMessage);
  });

  await openPromise;

  return {
    async subscribe(assetIds: string[]): Promise<void> {
      const newAssetIds = assetIds.filter((assetId) => !subscribedAssetIds.has(assetId));
      if (newAssetIds.length === 0 || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      for (let index = 0; index < newAssetIds.length; index += WS_SUBSCRIPTION_BATCH_SIZE) {
        const chunk = newAssetIds.slice(index, index + WS_SUBSCRIPTION_BATCH_SIZE);
        ws.send(
          JSON.stringify({
            type: 'MARKET',
            assets_ids: chunk,
          }),
        );
      }

      for (const assetId of newAssetIds) {
        subscribedAssetIds.add(assetId);
      }
    },
    async stop(): Promise<void> {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'phase0 capture complete');
      }
    },
  };
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
