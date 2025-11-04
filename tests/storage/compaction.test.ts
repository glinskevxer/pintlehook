import { beforeEach, describe, expect, it } from 'vitest';
import {
  SETTLED_KINDS,
  archivableRecords,
  describeOldestOpen,
  describePlan,
  oldestOpenDay,
  planCompaction,
  retainedLog,
  safeCheckpoint,
} from '../../src/storage/compaction.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { checkAgainstLog } from '../../src/storage/snapshot.js';
import { carrierId } from '../../src/domain/identity.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 2);

function carrier(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'carrier_filed',
    key: carrierId(id),
    payload: {
      carrier: carrierId(id),
      legalName: `Carrier ${id}`,
      motorCarrierNumber: `MC90000${id}`,
      dotNumber: `550000${id}`,
      authorityStatus: 'active',
      remitDigest: `r${id}`,
      bankDigest: `b${id}`,
      powerUnits: 1,
    },
  };
}

function batch(id: string, cutOn: string): JournalDraft {
  return {
    at: AT,
    kind: 'batch_cut',
    key: id,
    payload: {
      batch: id,
      periodFrom: '2025-05-01',
      periodUntil: '2025-06-01',
      cutOn,
      currency: 'USD',
    },
  };
}

function paid(id: string): JournalDraft[] {
  return [
    { at: AT, kind: 'batch_released', key: id, payload: { batch: id, releasedOn: '2025-06-03' } },
    { at: AT, kind: 'batch_paid', key: id, payload: { batch: id, paidOn: '2025-06-05' } },
  ];
}

let store: Store;

beforeEach(() => {
  store = Store.empty();
  unwrap(store.commit([carrier(1), carrier(2), carrier(3)]));
});

describe('the settled kinds', () => {
  it('are the ones nothing later depends on', () => {
    expect(SETTLED_KINDS).toContain('batch_paid');
    expect(new Set(SETTLED_KINDS).size).toBe(SETTLED_KINDS.length);
  });
});

describe('planCompaction', () => {
  it('reports what is archivable and what is retained', () => {
    const plan = unwrap(planCompaction(store, 2));
    expect(plan.archivable).toBe(2);
    expect(plan.retained).toBe(1);
    expect(plan.upToSequence).toBe(2);
  });

  it('takes a snapshot that still loads against the journal', () => {
    const plan = unwrap(planCompaction(store, 2));
    expect(unwrap(checkAgainstLog(plan.snapshot, store.journal))).toBe(0);
  });

  it('lists the paid batches', () => {
    unwrap(store.commit([batch('bch_1', '2025-06-02'), ...paid('bch_1')]));
    expect(unwrap(planCompaction(store, 3)).settledBatches).toEqual(['bch_1']);
  });

  it('refuses a checkpoint past the end', () => {
    const r = planCompaction(store, 99);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('compaction_point_ahead');
    }
  });

  it('refuses a checkpoint that is not a whole number from zero', () => {
    expect(isErr(planCompaction(store, -1))).toBe(true);
    expect(isErr(planCompaction(store, 1.5))).toBe(true);
  });

  it('accepts a checkpoint of zero, which archives nothing', () => {
    const plan = unwrap(planCompaction(store, 0));
    expect(plan.archivable).toBe(0);
    expect(plan.retained).toBe(store.sequence);
  });
});

describe('safeCheckpoint', () => {
  it('is the whole journal when every batch is paid', () => {
    unwrap(store.commit([batch('bch_1', '2025-06-02'), ...paid('bch_1')]));
    expect(safeCheckpoint(store)).toBe(store.sequence);
  });

  it('is the whole journal when there are no batches at all', () => {
    expect(safeCheckpoint(store)).toBe(store.sequence);
  });

  it('stops before the first record of a batch still moving', () => {
    unwrap(store.commit([batch('bch_1', '2025-06-02')]));
    expect(safeCheckpoint(store)).toBe(3);
  });

  it('stops before the oldest unpaid batch when two are open', () => {
    unwrap(store.commit([batch('bch_1', '2025-06-02'), batch('bch_2', '2025-07-02')]));
    expect(safeCheckpoint(store)).toBe(3);
  });

  it('moves forward once the older batch is paid', () => {
    unwrap(store.commit([batch('bch_1', '2025-06-02'), ...paid('bch_1')]));
    const before = safeCheckpoint(store);
    unwrap(store.commit([batch('bch_2', '2025-07-02')]));
    expect(safeCheckpoint(store)).toBeGreaterThan(3);
    expect(before).toBe(6);
  });
});

describe('archivableRecords', () => {
  it('gives the records up to the checkpoint', () => {
    expect(archivableRecords(store, 2)).toHaveLength(2);
    expect(archivableRecords(store, 0)).toEqual([]);
  });

  it('never throws anything away by itself', () => {
    archivableRecords(store, 3);
    expect(store.sequence).toBe(3);
    expect(unwrap(store.journal.verify())).toBe(3);
  });
});

describe('retainedLog', () => {
  it('keeps a journal that still verifies', () => {
    const log = unwrap(retainedLog(store, 1));
    expect(unwrap(log.verify())).toBe(store.sequence);
  });
});

describe('oldestOpenDay', () => {
  it('is nothing when every batch is paid', () => {
    unwrap(store.commit([batch('bch_1', '2025-06-02'), ...paid('bch_1')]));
    expect(unwrap(oldestOpenDay(store))).toBeUndefined();
    expect(describeOldestOpen(undefined)).toBe('every batch is paid');
  });

  it('is the earliest cut day among the open ones', () => {
    unwrap(store.commit([batch('bch_2', '2025-07-02'), batch('bch_1', '2025-06-02')]));
    expect(unwrap(oldestOpenDay(store))).toEqual(day(2025, 6, 2));
    expect(describeOldestOpen(day(2025, 6, 2))).toContain('2025-06-02');
  });

  it('fails on a batch whose cut day cannot be read', () => {
    unwrap(store.commit([batch('bch_1', 'soon')]));
    expect(isErr(oldestOpenDay(store))).toBe(true);
  });
});

describe('describePlan', () => {
  it('reads the way the operator report reads', () => {
    expect(describePlan(unwrap(planCompaction(store, 2)))).toBe(
      'checkpoint at 2, 2 archivable, 1 retained, 0 paid batches',
    );
  });
});
