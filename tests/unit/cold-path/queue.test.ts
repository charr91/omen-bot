import { describe, expect, it, vi } from 'vitest';
import {
  FundingGraphRebuildJobQueue,
  parseColdWorkerHeartbeat,
  recordFundingGraphRebuildFailureCooldown,
} from '../../../src/cold-path/queue.js';
import { buildFundingGraphRebuildCooldownKey } from '../../../src/cold-path/constants.js';

describe('FundingGraphRebuildJobQueue', () => {
  it('queues a rebuild when the wallet is not cooling down or already queued', async () => {
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(null),
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
      getJobState: vi.fn().mockResolvedValue('unknown'),
    };
    const redis = {
      disconnect: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const jobQueue = new FundingGraphRebuildJobQueue(queue, redis, true);

    await expect(jobQueue.requestRebuild('0xAbc')).resolves.toBe('queued');
    expect(queue.add).toHaveBeenCalledWith(
      'funding-graph-rebuild',
      {
        walletAddress: '0xabc',
        requestedAt: expect.any(String),
      },
      {
        jobId: '0xabc',
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  });

  it('dedupes queued wallets and respects failure cooldowns', async () => {
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue(null),
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 0, delayed: 0 }),
      getJobState: vi.fn().mockResolvedValue('active'),
    };
    const redis = {
      disconnect: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const jobQueue = new FundingGraphRebuildJobQueue(queue, redis, true);

    await expect(jobQueue.requestRebuild('0xAbc')).resolves.toBe('duplicate');

    redis.get.mockResolvedValueOnce(String(Date.now() + 30_000));
    queue.getJobState.mockResolvedValueOnce('unknown');
    await expect(jobQueue.requestRebuild('0xAbc')).resolves.toBe('cooldown');
  });

  it('clears failed jobs before requeueing the same wallet', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const queue = {
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getJob: vi.fn().mockResolvedValue({ remove }),
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, failed: 1, delayed: 0 }),
      getJobState: vi.fn().mockResolvedValue('failed'),
    };
    const redis = {
      disconnect: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const jobQueue = new FundingGraphRebuildJobQueue(queue, redis, true);

    await expect(jobQueue.requestRebuild('0xAbc')).resolves.toBe('queued');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('recordFundingGraphRebuildFailureCooldown', () => {
  it('stores the cooldown under the canonical wallet key', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
    };

    await recordFundingGraphRebuildFailureCooldown(redis, '0xAbC', 15_000);

    expect(redis.set).toHaveBeenCalledWith(
      buildFundingGraphRebuildCooldownKey('0xabc'),
      expect.any(String),
      'PX',
      15_000,
    );
  });
});

describe('parseColdWorkerHeartbeat', () => {
  it('returns null fields when no heartbeat exists', () => {
    expect(parseColdWorkerHeartbeat(null)).toEqual({
      at: null,
      lastCompletedAt: null,
      lastFailedAt: null,
    });
  });

  it('parses cold-worker heartbeat payloads', () => {
    expect(
      parseColdWorkerHeartbeat(
        JSON.stringify({
          at: '2026-04-01T12:00:00.000Z',
          lastCompletedAt: '2026-04-01T11:59:00.000Z',
          lastFailedAt: null,
        }),
      ),
    ).toEqual({
      at: '2026-04-01T12:00:00.000Z',
      lastCompletedAt: '2026-04-01T11:59:00.000Z',
      lastFailedAt: null,
    });
  });
});
