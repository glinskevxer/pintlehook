import { describe, expect, it } from 'vitest';
import {
  describeMetrics,
  isBadDelivery,
  measure,
  measureAll,
  needsAConversation,
  windowOf,
} from '../../src/ingest/metrics.js';
import type { PipelineSummary } from '../../src/ingest/pipeline.js';
import { isErr, unwrap } from '../../src/util/result.js';

function summary(overrides: Partial<PipelineSummary> = {}): PipelineSummary {
  return {
    source: 'fuel-desk',
    sequence: 1,
    rowsIn: 100,
    accepted: 100,
    duplicates: 0,
    quarantined: 0,
    replay: false,
    ...overrides,
  };
}

describe('windowOf', () => {
  it('keeps the last deliveries in sequence order', () => {
    const window = unwrap(
      windowOf(
        [summary({ sequence: 3 }), summary({ sequence: 1 }), summary({ sequence: 2 })],
        'fuel-desk',
        'touch',
        2,
      ),
    );
    expect(window.deliveries.map((d) => d.sequence)).toEqual([2, 3]);
  });

  it('leaves other sources out', () => {
    const window = unwrap(
      windowOf(
        [summary(), summary({ source: 'recruiting', sequence: 2 })],
        'fuel-desk',
        'touch',
        5,
      ),
    );
    expect(window.deliveries).toHaveLength(1);
  });

  it('handles a source that has shipped nothing', () => {
    expect(unwrap(windowOf([], 'fuel-desk', 'touch', 5)).deliveries).toEqual([]);
  });

  it('refuses a window of nothing', () => {
    const r = windowOf([], 'fuel-desk', 'touch', 0);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('metrics_window_invalid');
    }
  });
});

describe('isBadDelivery', () => {
  it('is false for a clean file', () => {
    expect(isBadDelivery(summary())).toBe(false);
  });

  it('is false at exactly one in twenty', () => {
    expect(isBadDelivery(summary({ accepted: 95, quarantined: 5 }))).toBe(false);
  });

  it('is true above one in twenty', () => {
    expect(isBadDelivery(summary({ accepted: 94, quarantined: 6 }))).toBe(true);
  });

  it('is false for an empty file', () => {
    expect(isBadDelivery(summary({ rowsIn: 0, accepted: 0, quarantined: 0 }))).toBe(false);
  });
});

describe('measure', () => {
  const window = unwrap(
    windowOf(
      [
        summary({ sequence: 1, accepted: 100 }),
        summary({ sequence: 2, accepted: 90, quarantined: 10, duplicates: 3 }),
        summary({ sequence: 3, accepted: 80, quarantined: 20 }),
      ],
      'fuel-desk',
      'touch',
      5,
    ),
  );
  const metrics = measure(window);

  it('adds the rows across the window', () => {
    expect(metrics.deliveries).toBe(3);
    expect(metrics.accepted).toBe(270);
    expect(metrics.quarantined).toBe(30);
    expect(metrics.duplicates).toBe(3);
  });

  it('gives an acceptance rate over the window, not the last file', () => {
    expect(metrics.acceptanceRate).toBeCloseTo(270 / 300);
  });

  it('counts the run of bad deliveries at the end', () => {
    expect(metrics.consecutiveBadDeliveries).toBe(2);
  });

  it('breaks the run on a good delivery', () => {
    const mixed = unwrap(
      windowOf(
        [
          summary({ sequence: 1, accepted: 80, quarantined: 20 }),
          summary({ sequence: 2, accepted: 100 }),
          summary({ sequence: 3, accepted: 80, quarantined: 20 }),
        ],
        'fuel-desk',
        'touch',
        5,
      ),
    );
    expect(measure(mixed).consecutiveBadDeliveries).toBe(1);
  });

  it('gives a rate of one for a source that has shipped nothing', () => {
    const empty = unwrap(windowOf([], 'fuel-desk', 'touch', 5));
    expect(measure(empty).acceptanceRate).toBe(1);
    expect(measure(empty).consecutiveBadDeliveries).toBe(0);
  });
});

describe('needsAConversation', () => {
  it('starts at three bad deliveries in a row', () => {
    const three = unwrap(
      windowOf(
        [
          summary({ sequence: 1, accepted: 80, quarantined: 20 }),
          summary({ sequence: 2, accepted: 80, quarantined: 20 }),
          summary({ sequence: 3, accepted: 80, quarantined: 20 }),
        ],
        'fuel-desk',
        'touch',
        5,
      ),
    );
    expect(needsAConversation(measure(three))).toBe(true);
  });

  it('does not fire on two', () => {
    const two = unwrap(
      windowOf(
        [
          summary({ sequence: 1, accepted: 100 }),
          summary({ sequence: 2, accepted: 80, quarantined: 20 }),
          summary({ sequence: 3, accepted: 80, quarantined: 20 }),
        ],
        'fuel-desk',
        'touch',
        5,
      ),
    );
    expect(needsAConversation(measure(two))).toBe(false);
  });
});

describe('measureAll', () => {
  it('measures every registered source', () => {
    const all = unwrap(
      measureAll(
        [summary(), summary({ source: 'recruiting', sequence: 1 })],
        [
          { source: 'fuel-desk', kind: 'touch' },
          { source: 'recruiting', kind: 'touch' },
        ],
        5,
      ),
    );
    expect(all.size).toBe(2);
    expect(all.get('fuel-desk/touch')!.accepted).toBe(100);
  });

  it('passes a bad window size through', () => {
    expect(isErr(measureAll([], [{ source: 'a', kind: 'touch' }], 0))).toBe(true);
  });
});

describe('describeMetrics', () => {
  it('reads the way the ingest dashboard prints it', () => {
    const window = unwrap(
      windowOf([summary({ accepted: 90, quarantined: 10 })], 'fuel-desk', 'touch', 5),
    );
    expect(describeMetrics(measure(window))).toBe(
      'fuel-desk accepted 90 percent over 1 deliveries',
    );
  });
});
