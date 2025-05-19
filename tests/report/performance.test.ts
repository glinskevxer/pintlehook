import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import {
  performanceFor,
  performanceReport,
  qualifyRate,
  reversalRate,
  totalNet,
} from '../../src/report/performance.js';
import { renderText } from '../../src/report/table.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 10, 1);

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

function referral(
  invitee: number,
  advocate: number,
  state: 'attributed' | 'qualified' | 'reversed',
): JournalDraft[] {
  const key = `prg_00000001:${carrierId(invitee)}`;
  const drafts: JournalDraft[] = [
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
        advocate: advocateId(advocate),
        effectiveActivation: '2025-02-01',
      },
    },
  ];
  if (state === 'qualified' || state === 'reversed') {
    drafts.push({
      at: AT,
      kind: 'referral_qualified',
      key,
      payload: { program: programId(1), invitee: carrierId(invitee), qualifiedOn: '2025-04-01' },
    });
  }
  if (state === 'reversed') {
    drafts.push({
      at: AT,
      kind: 'referral_reversed',
      key,
      payload: {
        program: programId(1),
        invitee: carrierId(invitee),
        reversedOn: '2025-08-01',
        reason: 'retention_failed',
      },
    });
  }
  return drafts;
}

function load(seq: number, invitee: number, marginMinor: number): JournalDraft {
  return {
    at: AT,
    kind: 'load_delivered',
    key: `lod_${seq}`,
    payload: {
      load: `lod_${seq}`,
      carrier: carrierId(invitee),
      proNumber: `PL-${seq}`,
      deliveredOn: '2025-03-10',
      lineHaulMinor: 200_000 + marginMinor,
      carrierPayMinor: 200_000,
      currency: 'USD',
      originState: 'IL',
      destinationState: 'TX',
    },
  };
}

function accrual(seq: number, advocate: number, amountMinor: number): JournalDraft {
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
      postedOn: '2025-04-01',
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
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
  unwrap(store.commit([carrier(1), carrier(2), enrolled(1), enrolled(2)]));
});

describe('a program nobody has used', () => {
  it('reports a row per advocate with nothing on it', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.referralsOpened).toBe(0);
    expect(rows[0]!.net.minor).toBe(0);
  });

  it('gives a qualify rate of zero rather than dividing by nothing', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    expect(qualifyRate(rows)).toBe(0);
    expect(reversalRate(rows)).toBe(0);
  });
});

describe('a program with traffic', () => {
  beforeEach(() => {
    unwrap(
      store.commit([
        ...referral(9, 1, 'qualified'),
        ...referral(8, 1, 'attributed'),
        ...referral(7, 2, 'reversed'),
        load(1, 9, 60_000),
        load(2, 9, 40_000),
        load(3, 7, 30_000),
        accrual(1, 1, 25_000),
        accrual(2, 2, 0),
      ]),
    );
  });

  it('counts opened, qualified and reversed per advocate', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    const first = rows.find((row) => row.advocate === advocateId(1))!;
    expect(first.referralsOpened).toBe(2);
    expect(first.referralsQualified).toBe(1);
    expect(first.referralsReversed).toBe(0);
    const second = rows.find((row) => row.advocate === advocateId(2))!;
    expect(second.referralsReversed).toBe(1);
  });

  it('adds the delivered margin of every invited carrier', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    expect(rows.find((row) => row.advocate === advocateId(1))!.deliveredMargin.minor).toBe(100_000);
  });

  it('takes the bounty cost off the margin', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    const first = rows.find((row) => row.advocate === advocateId(1))!;
    expect(first.bountyCost.minor).toBe(25_000);
    expect(first.net.minor).toBe(75_000);
  });

  it('counts a reversed referral in the reversal rate', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    expect(reversalRate(rows)).toBeCloseTo(0.5);
  });

  it('reports the qualify rate over everything opened', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    expect(qualifyRate(rows)).toBeCloseTo(1 / 3);
  });

  it('adds the net across the program', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    expect(totalNet(rows, 'USD').minor).toBe(105_000);
  });

  it('orders by advocate so the report is repeatable', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    expect(rows.map((row) => row.advocate)).toEqual([advocateId(1), advocateId(2)]);
  });
});

describe('performanceReport', () => {
  beforeEach(() => {
    unwrap(
      store.commit([...referral(9, 1, 'qualified'), load(1, 9, 60_000), accrual(1, 1, 25_000)]),
    );
  });

  it('names both sides in the footnote', () => {
    const rows = unwrap(performanceFor(context, programId(1), 'USD'));
    const report = performanceReport(rows, 'USD');
    expect(report.footnotes[0]).toContain('25000');
    expect(report.footnotes[0]).toContain('60000');
  });

  it('says the margin is what was delivered', () => {
    const report = performanceReport(unwrap(performanceFor(context, programId(1), 'USD')), 'USD');
    expect(report.footnotes.join(' ')).toContain('not a forecast');
  });

  it('renders a row per advocate', () => {
    const report = performanceReport(unwrap(performanceFor(context, programId(1), 'USD')), 'USD');
    const text = renderText(report);
    expect(text).toContain(advocateId(1));
    expect(text).toContain('600.00 USD');
  });
});
