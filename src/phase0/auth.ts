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
  const clobModule = (await import('@polymarket/clob-client')) as {
    ClobClient: ClobClientConstructor;
  };

  const signer = new walletModule.Wallet(privateKey);
  const signatureType = Number(process.env.POLY_SIGNATURE_TYPE ?? '0');
  const funder = process.env.POLY_FUNDER ?? signer.address;

  const tempClient = new clobModule.ClobClient(POLYMARKET_CLOB_URL, POLYGON_CHAIN_ID, signer);
  const creds = await deriveApiCreds(tempClient);
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

async function deriveApiCreds(client: TempTradeClient): Promise<ApiCredsShape> {
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

  if (client.createOrDeriveApiKey) {
    return parseApiCreds(await client.createOrDeriveApiKey());
  }

  if (client.createOrDeriveApiCreds) {
    return parseApiCreds(await client.createOrDeriveApiCreds());
  }

  throw new Error('Installed @polymarket/clob-client does not expose API credential helpers');
}

function parseApiCreds(input: unknown): ApiCredsShape {
  const value = asJsonObject(input, 'API credentials');

  const key = typeof value.key === 'string' ? value.key : typeof value.apiKey === 'string' ? value.apiKey : null;
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
    throw new Error('Unable to parse authenticated Polymarket API credentials');
  }

  return {
    key,
    secret,
    passphrase,
  };
}

