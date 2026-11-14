import { z } from 'zod';

/**
 * Local stand-in for the optional private `@charr91/smart-money-feed` package.
 * Envelope parsing matches the v1 contract. FeedClient / XBridge are no-ops so
 * `pnpm install` and tests work without access to the private repo. The runtime
 * loader in sdk.ts prefers the real package when it is installed.
 */

export const ENVELOPE_SCHEMA_VERSION = 1 as const;
export const SOURCE_APPS = ['omen', 'haruspex'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const PREDICTION_VENUES = ['polymarket', 'kalshi'] as const;
export const TOKEN_CHAINS = ['solana', 'base', 'bnb', 'robinhood', 'ethereum'] as const;
export const VENUES = [...PREDICTION_VENUES, ...TOKEN_CHAINS] as const;

export type SourceApp = (typeof SOURCE_APPS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Venue = (typeof VENUES)[number];

export const alertEnvelopeSchema = z.object({
  schemaVersion: z.literal(ENVELOPE_SCHEMA_VERSION),
  sourceApp: z.enum(SOURCE_APPS),
  alertKey: z.string().min(1).max(200),
  kind: z.enum(['signal', 'baseline']).default('signal'),
  refAlertKey: z.string().min(1).max(200).nullable().default(null),
  venue: z.enum(VENUES),
  subject: z.object({
    id: z.string().min(1),
    instrumentId: z.string().min(1).nullable().default(null),
    label: z.string().default(''),
    url: z.string().url().nullable().default(null),
  }),
  direction: z.enum(['long', 'short']),
  priceAtAlert: z.number().finite().nonnegative().nullable(),
  sizeUsd: z.number().finite().nonnegative().nullable().default(null),
  severity: z.enum(SEVERITIES),
  signals: z.array(z.string().min(1)).min(1),
  appTier: z.string().nullable().default(null),
  paramSetVersion: z.string().nullable().default(null),
  evidenceUrl: z.string().url().nullable().default(null),
  details: z.record(z.string(), z.string()).default({}),
  alertAt: z.coerce.date(),
  deliver: z.boolean().default(false),
  scoreBy: z.enum(['app', 'feed']).default('app'),
});

export type AlertEnvelope = z.infer<typeof alertEnvelopeSchema>;
export type AlertEnvelopeInput = z.input<typeof alertEnvelopeSchema>;

export function parseEnvelope(input: unknown): AlertEnvelope {
  return alertEnvelopeSchema.parse(input);
}

export interface OutcomeUpdate {
  price1h?: number | null;
  price24h?: number | null;
  resolutionPrice?: number | null;
  peakMultiple24h?: number | null;
  peakMultiple48h?: number | null;
  peakHit?: boolean | null;
}

export interface PublishResult {
  id: string;
  inserted: boolean;
  deliveryStatus: string;
}

export class FeedClient {
  constructor(_db: unknown) {}

  async ensureSchema(): Promise<void> {}

  async publish(_input: unknown): Promise<PublishResult> {
    return { id: 'shim', inserted: false, deliveryStatus: 'stored' };
  }

  async recordOutcome(_sourceApp: string, _alertKey: string, _update: OutcomeUpdate, _source: 'app' | 'feed' = 'app'): Promise<boolean> {
    return false;
  }
}

export type XSource = 'grokbot' | 'scraper' | 'third_party';
export type XQueryKind = 'handle' | 'token' | 'keywords';

export interface XBudget {
  dailyReads: number;
  perMinute: number;
  maxResultsPerCall: number;
}

export const DEFAULT_X_BUDGET: XBudget = { dailyReads: 1000, perMinute: 30, maxResultsPerCall: 25 };

export interface XBridgeOptions {
  budget: XBudget;
  claimTtlMs: number;
  pendingTtlMs: number;
  reuseWindowMs: number;
  maxAttempts: number;
}

export const DEFAULT_X_OPTIONS: XBridgeOptions = {
  budget: DEFAULT_X_BUDGET,
  claimTtlMs: 15 * 60_000,
  pendingTtlMs: 6 * 3_600_000,
  reuseWindowMs: 30 * 60_000,
  maxAttempts: 3,
};

export function loadXOptions(env: NodeJS.ProcessEnv = process.env): XBridgeOptions {
  const num = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    budget: {
      dailyReads: num('FEED_X_DAILY_READS', DEFAULT_X_BUDGET.dailyReads),
      perMinute: num('FEED_X_PER_MINUTE', DEFAULT_X_BUDGET.perMinute),
      maxResultsPerCall: Math.min(25, num('FEED_X_MAX_RESULTS', DEFAULT_X_BUDGET.maxResultsPerCall)),
    },
    claimTtlMs: num('FEED_X_CLAIM_TTL_MS', DEFAULT_X_OPTIONS.claimTtlMs),
    pendingTtlMs: num('FEED_X_PENDING_TTL_MS', DEFAULT_X_OPTIONS.pendingTtlMs),
    reuseWindowMs: num('FEED_X_REUSE_WINDOW_MS', DEFAULT_X_OPTIONS.reuseWindowMs),
    maxAttempts: num('FEED_X_MAX_ATTEMPTS', DEFAULT_X_OPTIONS.maxAttempts),
  };
}

export interface XRequestInput {
  sourceApp: SourceApp;
  alertKey: string;
  alertAt?: string;
  kind: XQueryKind;
  query: string;
  priority?: number;
  since?: string;
  until?: string;
  maxResults?: number;
}

export interface EnqueueResult {
  requestId: string;
  outcome: 'created' | 'joined' | 'reused';
  status: string;
}

export type ChatterTrend = 'quiet' | 'rising' | 'steady' | 'falling' | 'busy';

export interface ChatterPost {
  postId: string;
  authorHandle: string;
  postedAt: Date;
  text: string;
  url: string | null;
  engagement: number;
}

export interface XChatter {
  trend: ChatterTrend;
  recent: number;
  prior: number;
  recentHours: number;
  priorHours: number;
  after: number;
  authors: number;
  capped: boolean;
  top: ChatterPost | null;
  summary: string;
}

export interface XAnnotation {
  alertKey: string;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'expired' | 'skipped';
  requestId: string;
  kind: XQueryKind;
  query: string;
  chatter: XChatter | null;
}

export class XBridge {
  constructor(_db: unknown, _options?: XBridgeOptions) {}

  async ensureSchema(): Promise<void> {}

  async getSource(): Promise<XSource> {
    return 'grokbot';
  }

  async enqueue(_input: XRequestInput, _now = new Date()): Promise<EnqueueResult> {
    return { requestId: 'shim', outcome: 'created', status: 'skipped' };
  }

  async annotations(_sourceApp: string, _alertKeys: string[]): Promise<Map<string, XAnnotation[]>> {
    return new Map();
  }
}
