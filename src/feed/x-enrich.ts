import type { Pool } from 'pg';
import type { XAnnotation, XBridge, XRequestInput } from '@charr91/smart-money-feed';
import type { StoredAlert } from '../types/alert.js';

/**
 * M4: X context for omen alerts through the shared bridge (x.source = grokbot). MEDIUM+ alerts enqueue a keyword
 * search for their market; when Grok Bot submits results, the annotator stores a chatter summary
 * ("quiet" vs "rising" before the bet) on omen's side and shows it.
 */
const TIER_PRIORITY: Record<string, number> = { CRITICAL: 90, HIGH: 70, MEDIUM: 50 };
const TIER_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

const STOPWORDS = new Set(
  ('will the a an of in on at by to for be is are was were and or than more less before after during this that with ' +
    'from as it its any who what which when where how does do did has have had reach hit above below between over ' +
    'under end out win wins next new yes no vs market price' ).split(' '),
);
const MONTHS = new Set(
  'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec'.split(' '),
);

function compactNumber(raw: string): string {
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return raw;
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}m`;
  if (n >= 1_000 && n % 100 === 0) return `${n / 1_000}k`;
  return String(n);
}

/** Market question -> a short X keyword query: distinctive words and numbers as people write them ($150,000 -> 150k). */
export function marketKeywords(question: string, maxTerms = 4): string | null {
  const terms: string[] = [];
  const tokens = question.replace(/[?!"“”()]/g, ' ').split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const cleaned = token.replace(/^[$'"]+|[,.:;'"]+$/g, '');
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (/^\$?\d[\d,]*(\.\d+)?[km]?%?$/.test(cleaned)) {
      const num = cleaned.replace(/^\$/, '');
      const value = Number(num.replace(/[,%km]/g, ''));
      // Day-of-month and years are dates, not subject terms.
      if (/^\d{4}$/.test(num) && value >= 1990 && value <= 2100) continue;
      if (/^\d{1,2}(st|nd|rd|th)?$/.test(num) && value <= 31) continue;
      terms.push(/[km%]$/.test(num) ? num.toLowerCase() : compactNumber(num));
    } else if (/^\d{1,2}(st|nd|rd|th)$/i.test(cleaned) || MONTHS.has(lower) || STOPWORDS.has(lower) || lower.length < 3) {
      continue;
    } else {
      terms.push(cleaned.replace(/'s$/i, ''));
    }
    if (terms.length >= maxTerms) break;
  }
  const unique = [...new Map(terms.map((t) => [t.toLowerCase(), t])).values()];
  return unique.length >= 1 && unique.join(' ').length >= 3 ? unique.join(' ') : null;
}

export function xRequestForAlert(alert: StoredAlert, minTier = 'MEDIUM'): XRequestInput | null {
  if ((TIER_RANK[alert.deliveryTier] ?? 0) < (TIER_RANK[minTier] ?? 2)) return null;
  const query = marketKeywords(alert.marketQuestion ?? '');
  if (!query) return null;
  const alertAt = new Date(alert.fillTimestamp ?? alert.promotedAt);
  return {
    sourceApp: 'omen',
    alertKey: alert.fillId,
    alertAt: alertAt.toISOString(),
    kind: 'keywords',
    query,
    priority: TIER_PRIORITY[alert.deliveryTier] ?? 50,
    since: new Date(alertAt.getTime() - 24 * 3_600_000).toISOString(),
  };
}

export const X_CONTEXT_SCHEMA_SQL = `
  create table if not exists alert_x_context (
    fill_id text primary key,
    request_id text not null,
    query text not null,
    status text not null default 'pending',
    trend text,
    summary text,
    chatter jsonb,
    enqueued_at timestamptz not null default now(),
    annotated_at timestamptz
  );
`;

export async function recordXRequest(db: Pick<Pool, 'query'>, fillId: string, requestId: string, query: string, status: string): Promise<void> {
  await db.query(
    `insert into alert_x_context (fill_id, request_id, query, status) values ($1, $2, $3, $4)
     on conflict (fill_id) do nothing`,
    [fillId, requestId, query, status],
  );
}

export interface AnnotatedAlert {
  fillId: string;
  status: string;
  trend: string | null;
  summary: string;
}

/** One annotator pass: pull bridge results for alerts still waiting (last 12h) and store the chatter summary. */
export async function annotatePendingAlerts(
  db: Pick<Pool, 'query'>,
  bridge: Pick<XBridge, 'annotations'>,
  maxAgeHours = 12,
): Promise<AnnotatedAlert[]> {
  const waiting = await db.query<{ fill_id: string }>(
    `select fill_id from alert_x_context where annotated_at is null and enqueued_at > now() - make_interval(hours => $1)`,
    [maxAgeHours],
  );
  if (waiting.rows.length === 0) return [];
  const notes = await bridge.annotations('omen', waiting.rows.map((r) => r.fill_id));
  const out: AnnotatedAlert[] = [];
  for (const [fillId, list] of notes) {
    const note: XAnnotation | undefined = list.find((n) => n.chatter) ?? list[0];
    if (!note || note.status === 'pending' || note.status === 'claimed') continue;
    const summary = note.chatter?.summary ?? `X search ${note.status}`;
    await db.query(
      `update alert_x_context set status = $2, trend = $3, summary = $4, chatter = $5::jsonb, annotated_at = now()
       where fill_id = $1`,
      [fillId, note.status, note.chatter?.trend ?? null, summary, note.chatter ? JSON.stringify(note.chatter) : null],
    );
    out.push({ fillId, status: note.status, trend: note.chatter?.trend ?? null, summary });
  }
  return out;
}
