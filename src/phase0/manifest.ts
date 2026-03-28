import { z } from 'zod';

export const captureManifestSchema = z.object({
  version: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  runDirectory: z.string(),
  requestedHours: z.number(),
  useAuth: z.boolean(),
  sources: z.object({
    gammaMarkets: z.string(),
    publicTrades: z.string(),
    orderBooks: z.string(),
    marketWebSocket: z.string(),
    authenticatedTrades: z.boolean(),
  }),
  discovery: z.object({
    activeAssets: z.number(),
    activeMarkets: z.number(),
  }),
  counts: z.object({
    publicTradeObservations: z.number(),
    orderBookSnapshots: z.number(),
    wsMessages: z.number(),
    authTradeObservations: z.number(),
  }),
});

