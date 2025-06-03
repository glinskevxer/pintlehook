import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import {
  BUCKET_EDGES,
  BUCKET_NAMES,
  agingFor,
  agingReport,
  bucketFor,
  bucketTotals,
  bucketsAddUp,
} from '../../src/report/aging.js';
import { renderText } from '../../src/report/table.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 1);
const ASOF = day(2025, 6, 1);

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

function enrolled(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'advocate_enrolled',
    key: advocateId(id),
    payload: {
      advocate: advocateId(id),
      carrier: carrierId(id),
      program: programId(1),
      referralCode: `CODE00${id}`,
      from: '2025-01-01',
    },
  };
}

function accrual(
  seq: number,
  advocate: number,
  postedOn: string,
  amountMinor: number,
): JournalDraft {
  return {
    at: AT,
    kind: 'accrual_posted',
    key: `acr_${seq}`,
    payload: {
      accrual: `acr_${seq}`,
      advocate: advocateId(advocate),
      program: programId(1),
      referralKey: 'prg_00000001:cxr_00000009',
      kind: 'base',
      postedOn,
      programYearFrom: '2025-01-01',
      amountMinor,
      currency: 'USD',
      reverses: '',
      note: 'bounty',
    },
  };
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'finance'));
  unwrap(store.commit([carrier(1), carrier(2), enrolled(1), enrolled(2)]));
});

describe('bucketFor', () => {
  it('names four buckets against three edges', () => {
    expect(BUCKET_NAMES).toHaveLength(BUCKET_EDGES.length + 1);
  });

  it('puts every age in exactly one bucket', () => {
    for (let age = 0; age <= 400; age += 1) {
      const at = bucketFor(age);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(BUCKET_NAMES.length);
    }
  });

  it('is open on the right at each edge', () => {
    expect(bucketFor(29)).toBe(0);
    expect(bucketFor(30)).toBe(1);
    expect(bucketFor(59)).toBe(1);
    expect(bucketFor(60)).toBe(2);
    expect(bucketFor(89)).toBe(2);
    expect(bucketFor(90)).toBe(3);
  });

  it('puts anything older in the last bucket', () => {
    expect(bucketFor(4000)).toBe(3);
  });
});

describe('agingFor', () => {
  it('skips an advocate with nothing posted', () => {
    expect(unwrap(agingFor(context, programId(1), ASOF, 'USD'))).toEqual([]);
  });

  it('buckets a posting by how long it has been sitting', () => {
    unwrap(
      store.commit([
        accrual(1, 1, '2025-05-20', 10_000),
        accrual(2, 1, '2025-04-20', 20_000),
        accrual(3, 1, '2025-03-20', 30_000),
        accrual(4, 1, '2025-01-20', 40_000),
      ]),
    );
    const row = unwrap(agingFor(context, programId(1), ASOF, 'USD'))[0]!;
    expect(row.buckets.map((bucket) => bucket.minor)).toEqual([10_000, 20_000, 30_000, 40_000]);
  });

  it('adds the buckets to the total', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-05-20', 10_000), accrual(2, 1, '2025-01-20', 40_000)]),
    );
    const row = unwrap(agingFor(context, programId(1), ASOF, 'USD'))[0]!;
    expect(row.total.minor).toBe(50_000);
    expect(bucketsAddUp(row)).toBe(true);
  });

  it('adds up even when a bucket holds a negative posting', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-05-20', 10_000), accrual(2, 1, '2025-01-20', -4_000)]),
    );
    const row = unwrap(agingFor(context, programId(1), ASOF, 'USD'))[0]!;
    expect(bucketsAddUp(row)).toBe(true);
    expect(row.total.minor).toBe(6_000);
  });

  it('names the oldest posting in days', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-05-20', 10_000), accrual(2, 1, '2025-01-20', 40_000)]),
    );
    expect(unwrap(agingFor(context, programId(1), ASOF, 'USD'))[0]!.oldestDays).toBe(132);
  });

  it('treats a posting dated in the future as nothing old', () => {
    unwrap(store.commit([accrual(1, 1, '2025-09-01', 10_000)]));
    const row = unwrap(agingFor(context, programId(1), ASOF, 'USD'))[0]!;
    expect(row.oldestDays).toBe(0);
    expect(row.buckets[0]!.minor).toBe(10_000);
  });

  it('reports each advocate separately', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-20', 10_000), accrual(2, 2, '2025-05-20', 7_000)]));
    const rows = unwrap(agingFor(context, programId(1), ASOF, 'USD'));
    expect(rows).toHaveLength(2);
  });

  it('fails on a posting whose day cannot be read', () => {
    unwrap(store.commit([accrual(1, 1, 'soon', 10_000)]));
    expect(isErr(agingFor(context, programId(1), ASOF, 'USD'))).toBe(true);
  });
});

describe('bucketTotals', () => {
  it('adds each bucket across every advocate', () => {
    unwrap(
      store.commit([
        accrual(1, 1, '2025-05-20', 10_000),
        accrual(2, 2, '2025-05-20', 7_000),
        accrual(3, 2, '2025-01-20', 3_000),
      ]),
    );
    const totals = bucketTotals(unwrap(agingFor(context, programId(1), ASOF, 'USD')), 'USD');
    expect(totals.map((total) => total.minor)).toEqual([17_000, 0, 0, 3_000]);
  });

  it('is all zeros for an empty report', () => {
    expect(bucketTotals([], 'USD').map((total) => total.minor)).toEqual([0, 0, 0, 0]);
  });
});

describe('agingReport', () => {
  beforeEach(() => {
    unwrap(
      store.commit([accrual(1, 1, '2025-05-20', 10_000), accrual(2, 1, '2025-01-20', 40_000)]),
    );
  });

  it('carries a column per bucket plus a total and the oldest', () => {
    const rows = unwrap(agingFor(context, programId(1), ASOF, 'USD'));
    const report = agingReport(rows, ASOF, 'USD');
    expect(report.columns.map((column) => column.key)).toEqual([
      'advocate',
      'b0',
      'b1',
      'b2',
      'b3',
      'total',
      'oldest',
    ]);
  });

  it('names the day it was run for', () => {
    const rows = unwrap(agingFor(context, programId(1), ASOF, 'USD'));
    expect(agingReport(rows, ASOF, 'USD').title).toContain('2025-06-01');
  });

  it('says how much is being carried', () => {
    const rows = unwrap(agingFor(context, programId(1), ASOF, 'USD'));
    expect(agingReport(rows, ASOF, 'USD').footnotes[0]).toContain('50000');
  });

  it('renders the bucket headings', () => {
    const rows = unwrap(agingFor(context, programId(1), ASOF, 'USD'));
    expect(renderText(agingReport(rows, ASOF, 'USD'))).toContain('90 and over');
  });
});
