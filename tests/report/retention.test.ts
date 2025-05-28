import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import {
  CHECKPOINTS,
  cohortsFor,
  retentionReport,
  shareAt,
  totalCarriers,
  weakestCohort,
} from '../../src/report/retention.js';
import { renderText } from '../../src/report/table.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2026, 0, 1);

function referral(invitee: number, activation: string): JournalDraft[] {
  const key = `prg_00000001:${carrierId(invitee)}`;
  return [
    {
      at: AT,
      kind: 'referral_opened',
      key,
      payload: { program: programId(1), invitee: carrierId(invitee), recordedOn: '2025-01-05' },
    },
    {
      at: AT,
      kind: 'referral_attributed',
      key,
      payload: {
        program: programId(1),
        invitee: carrierId(invitee),
        advocate: advocateId(1),
        effectiveActivation: activation,
      },
    },
  ];
}

function load(seq: number, invitee: number, deliveredOn: string): JournalDraft {
  return {
    at: AT,
    kind: 'load_delivered',
    key: `lod_${seq}`,
    payload: {
      load: `lod_${seq}`,
      carrier: carrierId(invitee),
      proNumber: `PL-${seq}`,
      deliveredOn,
      lineHaulMinor: 250_000,
      carrierPayMinor: 200_000,
      currency: 'USD',
      originState: 'IL',
      destinationState: 'TX',
    },
  };
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
});

describe('checkpoints', () => {
  it('runs to a hundred and eighty days', () => {
    expect(CHECKPOINTS).toEqual([30, 60, 90, 180]);
  });
});

describe('an empty program', () => {
  it('has no cohorts', () => {
    expect(unwrap(cohortsFor(context, programId(1)))).toEqual([]);
    expect(totalCarriers([])).toBe(0);
    expect(weakestCohort([], 0)).toBeUndefined();
  });
});

describe('cohorting', () => {
  it('groups by the month the carrier activated', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-10'),
        ...referral(8, '2025-02-25'),
        ...referral(7, '2025-03-04'),
      ]),
    );
    const rows = unwrap(cohortsFor(context, programId(1)));
    expect(rows.map((row) => row.cohort)).toEqual(['2025-02', '2025-03']);
    expect(rows[0]!.carriers).toBe(2);
  });

  it('does not cohort on the day the referral was recorded', () => {
    unwrap(store.commit([...referral(9, '2025-04-01')]));
    const rows = unwrap(cohortsFor(context, programId(1)));
    expect(rows[0]!.cohort).toBe('2025-04');
  });

  it('counts a carrier hauling in the window ending at a checkpoint', () => {
    unwrap(store.commit([...referral(9, '2025-02-01'), load(1, 9, '2025-02-20')]));
    const rows = unwrap(cohortsFor(context, programId(1)));
    expect(rows[0]!.stillHauling[0]).toBe(1);
    expect(rows[0]!.stillHauling[1]).toBe(0);
  });

  it('counts a carrier at every checkpoint they kept hauling through', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-20'),
        load(2, 9, '2025-03-20'),
        load(3, 9, '2025-04-20'),
        load(4, 9, '2025-07-20'),
      ]),
    );
    const rows = unwrap(cohortsFor(context, programId(1)));
    expect(rows[0]!.stillHauling).toEqual([1, 1, 1, 1]);
  });

  it('leaves a checkpoint that has not arrived yet at nothing', () => {
    const early = unwrap(
      contextFor(store, fixedClock(Date.UTC(2025, 2, 15)), 'America/Chicago', 'desk'),
    );
    unwrap(store.commit([...referral(9, '2025-02-01'), load(1, 9, '2025-02-20')]));
    const rows = unwrap(cohortsFor(early, programId(1)));
    expect(rows[0]!.stillHauling[0]).toBe(1);
    expect(rows[0]!.stillHauling[3]).toBe(0);
  });

  it('counts a reversed referral in its cohort', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        {
          at: AT,
          kind: 'referral_qualified',
          key: 'prg_00000001:cxr_00000009',
          payload: { program: programId(1), invitee: carrierId(9), qualifiedOn: '2025-03-01' },
        },
        {
          at: AT,
          kind: 'referral_reversed',
          key: 'prg_00000001:cxr_00000009',
          payload: {
            program: programId(1),
            invitee: carrierId(9),
            reversedOn: '2025-08-01',
            reason: 'retention_failed',
          },
        },
      ]),
    );
    expect(unwrap(cohortsFor(context, programId(1)))[0]!.carriers).toBe(1);
  });

  it('leaves a referral nobody attributed out entirely', () => {
    unwrap(
      store.commit([
        {
          at: AT,
          kind: 'referral_opened',
          key: 'prg_00000001:cxr_00000009',
          payload: { program: programId(1), invitee: carrierId(9), recordedOn: '2025-01-05' },
        },
      ]),
    );
    expect(unwrap(cohortsFor(context, programId(1)))).toEqual([]);
  });
});

describe('shareAt', () => {
  it('is the share of the cohort still hauling', () => {
    const row = { cohort: '2025-02', carriers: 4, stillHauling: [3, 2, 1, 0] };
    expect(shareAt(row, 0)).toBeCloseTo(0.75);
    expect(shareAt(row, 3)).toBe(0);
  });

  it('is zero for an empty cohort rather than dividing by nothing', () => {
    expect(shareAt({ cohort: '2025-02', carriers: 0, stillHauling: [0, 0, 0, 0] }, 0)).toBe(0);
  });

  it('is zero for a checkpoint past the end of the list', () => {
    expect(shareAt({ cohort: '2025-02', carriers: 4, stillHauling: [1] }, 3)).toBe(0);
  });
});

describe('retentionReport', () => {
  it('carries a column per checkpoint', () => {
    unwrap(store.commit([...referral(9, '2025-02-01'), load(1, 9, '2025-02-20')]));
    const report = retentionReport(unwrap(cohortsFor(context, programId(1))), day(2026, 1, 1));
    expect(report.columns.map((column) => column.key)).toEqual([
      'cohort',
      'carriers',
      'd30',
      'd60',
      'd90',
      'd180',
    ]);
  });

  it('renders the shares as percentages', () => {
    unwrap(store.commit([...referral(9, '2025-02-01'), load(1, 9, '2025-02-20')]));
    const report = retentionReport(unwrap(cohortsFor(context, programId(1))), day(2026, 1, 1));
    expect(renderText(report)).toContain('100%');
    expect(renderText(report)).toContain('0%');
  });

  it('says what a cohort is in the footnote', () => {
    const report = retentionReport([], day(2026, 1, 1));
    expect(report.footnotes[0]).toContain('activated');
  });
});

describe('totalCarriers and weakestCohort', () => {
  it('adds every cohort', () => {
    unwrap(store.commit([...referral(9, '2025-02-01'), ...referral(8, '2025-03-01')]));
    expect(totalCarriers(unwrap(cohortsFor(context, programId(1))))).toBe(2);
  });

  it('finds the cohort that fell away fastest', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-20'),
        ...referral(8, '2025-03-01'),
      ]),
    );
    const rows = unwrap(cohortsFor(context, programId(1)));
    expect(weakestCohort(rows, 0)!.cohort).toBe('2025-03');
  });
});
