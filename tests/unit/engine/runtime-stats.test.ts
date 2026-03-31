import { describe, expect, it } from 'vitest';
import { RuntimeStatsCollector } from '../../../src/engine/runtime-stats.js';

describe('RuntimeStatsCollector', () => {
  it('aggregates ingestion and worker metrics into a runtime-stats log', () => {
    const collector = new RuntimeStatsCollector();
    collector.recordIngestionCycle({
      fetched: 8,
      inserted: 5,
      replayed: 3,
    });
    collector.recordIngestionCycle({
      fetched: 2,
      inserted: 1,
      replayed: 0,
    });

    const log = collector.buildLog(
      {
        queueDepth: 4,
        pendingFillCount: 7,
        processing: true,
        lastHeartbeatAt: '2026-03-31T02:00:00.000Z',
        lastProcessedAt: '2026-03-31T01:59:30.000Z',
      },
      {
        enqueueAccepted: 6,
        enqueueDuplicate: 1,
        enqueueFull: 2,
        processed: 5,
        failed: 1,
        alertPreviewCountsBySignalId: {
          OUTSIZED_POSITION: 2,
        },
      },
      new Date('2026-03-31T02:00:00.000Z'),
    );

    expect(log.type).toBe('runtime-stats');
    expect(log.ingest).toEqual({
      cycles: 2,
      fetched: 10,
      inserted: 6,
      replayAccepted: 3,
    });
    expect(log.hotWorker.enqueueFull).toBe(2);
    expect(log.hotWorker.lastProcessedAgeMs).toBe(30_000);
    expect(log.alerts.previewCountsBySignalId.OUTSIZED_POSITION).toBe(2);
  });
});
