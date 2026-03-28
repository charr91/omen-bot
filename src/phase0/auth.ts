import { POLYMARKET_CLOB_URL, POLYGON_CHAIN_ID } from './constants.js';
import { asJsonObject } from './json.js';
import type { JsonObject } from './types.js';

interface ApiCredsShape {
  key: string;
  secret: string;
  passphrase: string;
}

interface AuthTradeClient {
  getTrades(params?: Record<string, unknown>): Promise<unknown>;
}

interface TempTradeClient extends AuthTradeClient {
  createOrDeriveApiKey?: () => Promise<unknown>;
  createOrDeriveApiCreds?: () => Promise<unknown>;
}

interface ClobClientConstructor {
  new (
    host: string,
    chainId: number,
    signer?: unknown,
    creds?: ApiCredsShape,
    signatureType?: number,
    funder?: string,
  ): TempTradeClient;
}

interface WalletConstructor {
  new (privateKey: string): {
    address: string;
  };
}

interface CreateL1Headers {
  (signer: unknown, chainId: number, nonce?: number, timestamp?: number): Promise<Record<string, string>>;
}

interface RawRequestClient {
  get(url: string, options?: Record<string, unknown>): Promise<unknown>;
  post(url: string, data?: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

export async function createAuthenticatedTradeReader(
  enabled: boolean,
): Promise<(() => Promise<JsonObject[]>) | null> {
  if (!enabled) {
    return null;
  }

  const privateKey = process.env.POLY_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'Missing POLY_PRIVATE_KEY or PRIVATE_KEY for --use-auth capture. Export credentials or omit --use-auth.',
    );
  }

  const walletModule = (await import('ethers')) as { Wallet: WalletConstructor };
  const clobModule = (await import('@polymarket/clob-client') as unknown) as {
    ClobClient: ClobClientConstructor;
    createL1Headers: CreateL1Headers;
  };

  const signer = new walletModule.Wallet(privateKey);
  const signatureType = Number(process.env.POLY_SIGNATURE_TYPE ?? '0');
  const funder = process.env.POLY_FUNDER ?? signer.address;

  const tempClient = new clobModule.ClobClient(POLYMARKET_CLOB_URL, POLYGON_CHAIN_ID, signer);
  const creds = await deriveApiCreds(tempClient, signer, clobModule.createL1Headers);
  const client = new clobModule.ClobClient(
    POLYMARKET_CLOB_URL,
    POLYGON_CHAIN_ID,
    signer,
    creds,
    signatureType,
    funder,
  );

  return async (): Promise<JsonObject[]> => {
    const response = await client.getTrades();
    if (!Array.isArray(response)) {
      throw new Error('Authenticated getTrades() returned a non-array payload');
    }

    return response.map((entry) => asJsonObject(entry, 'authenticated trade'));
  };
}

async function deriveApiCreds(
  client: TempTradeClient,
  signer: unknown,
  createL1Headers: CreateL1Headers,
): Promise<ApiCredsShape> {
  const envKey = process.env.POLY_API_KEY;
  const envSecret = process.env.POLY_API_SECRET;
  const envPassphrase = process.env.POLY_API_PASSPHRASE;

  if (envKey && envSecret && envPassphrase) {
    return {
      key: envKey,
      secret: envSecret,
      passphrase: envPassphrase,
    };
  }

  const createdCreds = await requestRawApiCreds(client, signer, createL1Headers, 'create');
  if (createdCreds) {
    return createdCreds;
  }

  const derivedCreds = await requestRawApiCreds(client, signer, createL1Headers, 'derive');
  if (derivedCreds) {
    return derivedCreds;
  }

  if (client.createOrDeriveApiKey) {
    const creds = tryParseApiCreds(await client.createOrDeriveApiKey());
    if (creds) {
      return creds;
    }
  }

  if (client.createOrDeriveApiCreds) {
    const creds = tryParseApiCreds(await client.createOrDeriveApiCreds());
    if (creds) {
      return creds;
    }
  }

  throw new Error('Unable to derive authenticated Polymarket API credentials');
}

async function requestRawApiCreds(
  client: TempTradeClient,
  signer: unknown,
  createL1Headers: CreateL1Headers,
  mode: 'create' | 'derive',
): Promise<ApiCredsShape | null> {
  const rawClient = client as unknown as Partial<RawRequestClient>;
  const headers = await createL1Headers(signer, POLYGON_CHAIN_ID);
  const endpoint =
    mode === 'create'
      ? `${POLYMARKET_CLOB_URL}/auth/api-key`
      : `${POLYMARKET_CLOB_URL}/auth/derive-api-key`;

  let response: unknown;
  if (mode === 'create') {
    if (!rawClient.post) {
      return null;
    }
    response = await rawClient.post(endpoint, undefined, { headers });
  } else {
    if (!rawClient.get) {
      return null;
    }
    response = await rawClient.get(endpoint, { headers });
  }

  return tryParseApiCreds(response);
}

export function parseApiCreds(input: unknown): ApiCredsShape {
  const creds = tryParseApiCreds(input);
  if (!creds) {
    throw new Error('Unable to parse authenticated Polymarket API credentials');
  }

  return creds;
}

function tryParseApiCreds(input: unknown): ApiCredsShape | null {
  let value: JsonObject;
  try {
    value = asJsonObject(input, 'API credentials');
  } catch {
    return null;
  }

  const key = typeof value.apiKey === 'string' ? value.apiKey : typeof value.key === 'string' ? value.key : null;
  const secret =
    typeof value.secret === 'string'
      ? value.secret
      : typeof value.apiSecret === 'string'
        ? value.apiSecret
        : null;
  const passphrase =
    typeof value.passphrase === 'string'
      ? value.passphrase
      : typeof value.apiPassphrase === 'string'
        ? value.apiPassphrase
        : null;

  if (!key || !secret || !passphrase) {
    return null;
  }

  return {
    key,
    secret,
    passphrase,
  };
}
