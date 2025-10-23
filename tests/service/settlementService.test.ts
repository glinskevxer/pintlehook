import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  capReached,
  cutBatch,
  lineFor,
  settledIdsOf,
  type SettlementRequest,
} from '../../src/service/settlementService.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 2);
const PERIOD = interval(day(2025, 5, 1), day(2025, 6, 1));

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 3,
  qualifyingWindowDays: 120,
  retentionDays: 180,
  programYearCapMinor: 0,
  releaseCeilingMinor: 100_000,
  currency: 'USD',
};

const schedule: RewardSchedule = {
  currency: 'USD',
  tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 }],
};

const program: Program = {
  id: programId(1),
  name: 'referral',
  openedOn: day(2024, 1, 1),
  versions: [{ version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'x' }],
};

const catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));

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
      referralKey: `prg_00000001:cxr_0000009${advocate}`,
      kind: amountMinor >= 0 ? 'base' : 'true_down',
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

function request(overrides: Partial<SettlementRequest> = {}): SettlementRequest {
  return {
    program: programId(1),
    period: PERIOD,
    cutOn: day(2025, 6, 2),
    currency: 'USD',
    ...overrides,
  };
}

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'settlement'));
  unwrap(store.commit([carrier(1), carrier(2), enrolled(1), enrolled(2)]));
});

describe('cutting a batch', () => {
  it('builds one line per advocate with something to settle', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 25_000)]));
    const plan = unwrap(cutBatch(context, catalog, request()));
    expect(plan.batch.lines).toHaveLength(1);
    expect(plan.batch.lines[0]!.advocate).toBe(advocateId(1));
  });

  it('pays the whole unsettled position, not only the period', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-04-10', 25_000), accrual(2, 1, '2025-05-10', 16_000)]),
    );
    const line = lineFor(unwrap(cutBatch(context, catalog, request())).batch, advocateId(1));
    expect(line!.periodAccruals.minor).toBe(16_000);
    expect(line!.netPosition.minor).toBe(41_000);
    expect(line!.payable.minor).toBe(41_000);
  });

  it('leaves out accruals already settled in an earlier batch', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-04-10', 25_000), accrual(2, 1, '2025-05-10', 16_000)]),
    );
    const plan = unwrap(
      cutBatch(context, catalog, request({ settledAccrualIds: new Set(['acr_1']) })),
    );
    expect(lineFor(plan.batch, advocateId(1))!.netPosition.minor).toBe(16_000);
  });

  it('orders lines by advocate so the register is repeatable', () => {
    unwrap(
      store.commit([accrual(1, 2, '2025-05-10', 25_000), accrual(2, 1, '2025-05-10', 25_000)]),
    );
    const plan = unwrap(cutBatch(context, catalog, request()));
    expect(plan.batch.lines.map((line) => line.advocate)).toEqual([advocateId(1), advocateId(2)]);
  });

  it('skips an advocate with nothing in the period and nothing outstanding', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 25_000)]));
    const plan = unwrap(cutBatch(context, catalog, request()));
    expect(lineFor(plan.batch, advocateId(2))).toBeUndefined();
  });

  it('writes a batch record that folds', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 25_000)]));
    const plan = unwrap(cutBatch(context, catalog, request()));
    unwrap(store.commit([...plan.drafts]));
    expect(store.batches.get(plan.batch.id)!.state).toBe('cut');
    expect(store.batches.get(plan.batch.id)!.periodFrom).toBe('2025-05-01');
  });

  it('refuses a cut before the period closes', () => {
    const r = cutBatch(context, catalog, request({ cutOn: day(2025, 5, 20) }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('settlement_cut_too_early');
    }
  });

  it('refuses an accrual in another currency', () => {
    unwrap(
      store.commit([
        {
          ...accrual(1, 1, '2025-05-10', 25_000),
          payload: { ...accrual(1, 1, '2025-05-10', 25_000).payload, currency: 'CAD' },
        },
      ]),
    );
    const r = cutBatch(context, catalog, request());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('settlement_currency_mismatch');
    }
  });

  it('fails for a program the catalogue does not hold', () => {
    expect(isErr(cutBatch(context, catalog, request({ program: programId(9) })))).toBe(true);
  });
});

describe('holds', () => {
  it('holds a negative position and pays nothing on that line', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-05-10', 25_000), accrual(2, 1, '2025-05-20', -40_000)]),
    );
    const plan = unwrap(cutBatch(context, catalog, request()));
    const line = lineFor(plan.batch, advocateId(1));
    expect(line!.hold.held).toBe(true);
    expect(line!.hold.reasons).toContain('negative_position');
    expect(line!.payable.minor).toBe(0);
    expect(plan.heldCount).toBe(1);
  });

  it('holds a payout below the minimum', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 400)]));
    const line = lineFor(unwrap(cutBatch(context, catalog, request())).batch, advocateId(1));
    expect(line!.hold.reasons).toContain('below_minimum');
  });

  it('holds on an open eligibility flag', () => {
    unwrap(
      store.commit([
        accrual(1, 1, '2025-05-10', 25_000),
        {
          at: AT,
          kind: 'eligibility_flag_raised',
          key: advocateId(1),
          payload: { advocate: advocateId(1), flag: 'w9_missing', raisedOn: '2025-03-01' },
        },
      ]),
    );
    const line = lineFor(unwrap(cutBatch(context, catalog, request())).batch, advocateId(1));
    expect(line!.hold.primaryReason).toBe('eligibility_flag_open');
  });

  it('pays once the flag is cleared', () => {
    unwrap(
      store.commit([
        accrual(1, 1, '2025-05-10', 25_000),
        {
          at: AT,
          kind: 'eligibility_flag_raised',
          key: advocateId(1),
          payload: { advocate: advocateId(1), flag: 'w9_missing', raisedOn: '2025-03-01' },
        },
        {
          at: AT,
          kind: 'eligibility_flag_cleared',
          key: advocateId(1),
          payload: { advocate: advocateId(1), flag: 'w9_missing', clearedOn: '2025-05-25' },
        },
      ]),
    );
    const line = lineFor(unwrap(cutBatch(context, catalog, request())).batch, advocateId(1));
    expect(line!.hold.held).toBe(false);
    expect(line!.payable.minor).toBe(25_000);
  });

  it('adds up the payable and the withheld across the batch', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-05-10', 25_000), accrual(2, 2, '2025-05-10', 30_000)]),
    );
    const plan = unwrap(cutBatch(context, catalog, request()));
    expect(plan.payableTotal.minor).toBe(55_000);
    expect(plan.withheldTotal.minor).toBe(0);
    expect(plan.heldCount).toBe(0);
  });
});

describe('settledIdsOf', () => {
  it('collects the accruals on the lines that paid', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 25_000), accrual(2, 2, '2025-05-10', 400)]));
    const plan = unwrap(cutBatch(context, catalog, request()));
    const ids = settledIdsOf(plan.batch);
    expect(ids.has('acr_1')).toBe(true);
    expect(ids.has('acr_2')).toBe(false);
  });

  it('is empty for a batch with no lines', () => {
    expect(settledIdsOf(unwrap(cutBatch(context, catalog, request())).batch).size).toBe(0);
  });
});

describe('the program year cap', () => {
  function capped(capMinor: number) {
    const withCap: Program = {
      ...program,
      versions: [
        {
          version: 1,
          effectiveFrom: day(2024, 1, 1),
          rules: { ...rules, programYearCapMinor: capMinor },
          note: 'capped',
        },
      ],
    };
    return unwrap(buildCatalog([withCap], [{ program: programId(1), version: 1, schedule }]));
  }

  it('is not reached when the rules set no cap', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 900_000)]));
    expect(capReached(context, advocateId(1), day(2025, 1, 1), 0)).toBe(false);
  });

  it('is reached once the year total meets the cap', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 60_000)]));
    expect(capReached(context, advocateId(1), day(2025, 1, 1), 60_000)).toBe(true);
    expect(capReached(context, advocateId(1), day(2025, 1, 1), 60_001)).toBe(false);
  });

  it('counts only the program year asked about', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 60_000)]));
    expect(capReached(context, advocateId(1), day(2026, 1, 1), 10_000)).toBe(false);
  });

  it('nets a reversal off before comparing', () => {
    unwrap(
      store.commit([accrual(1, 1, '2025-05-10', 60_000), accrual(2, 1, '2025-05-20', -40_000)]),
    );
    expect(capReached(context, advocateId(1), day(2025, 1, 1), 60_000)).toBe(false);
  });

  it('holds the settlement line once the cap is reached', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 60_000)]));
    const plan = unwrap(
      cutBatch(context, capped(60_000), request({ programYearFrom: day(2025, 1, 1) })),
    );
    const line = lineFor(plan.batch, advocateId(1));
    expect(line!.hold.reasons).toContain('program_year_cap_reached');
    expect(line!.payable.minor).toBe(0);
  });

  it('pays the same line under a higher cap', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 60_000)]));
    const plan = unwrap(
      cutBatch(context, capped(90_000), request({ programYearFrom: day(2025, 1, 1) })),
    );
    const line = lineFor(plan.batch, advocateId(1));
    expect(line!.hold.held).toBe(false);
    expect(line!.payable.minor).toBe(60_000);
  });

  it('measures the year from the period start when none was given', () => {
    unwrap(store.commit([accrual(1, 1, '2025-05-10', 60_000)]));
    const plan = unwrap(cutBatch(context, capped(60_000), request()));
    expect(lineFor(plan.batch, advocateId(1))!.hold.held).toBe(false);
  });
});
