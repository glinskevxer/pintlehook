import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog, type Catalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  accrualPass,
  clawbackPass,
  positionOf,
  qualifiedReferralsOf,
  qualifyPass,
  runCycle,
  undatedAccruals,
  type CycleRequest,
} from '../../src/service/cycle.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import { lineFor } from '../../src/service/settlementService.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 11, 2);
const PROGRAM_YEAR = interval(day(2025, 1, 1), day(2026, 1, 1));

const rules: ProgramRules = {
  attributionWindowDays: 90,
  cureWindowDays: 21,
  qualifyingLoadCount: 2,
  qualifyingWindowDays: 120,
  retentionDays: 180,
  programYearCapMinor: 0,
  releaseCeilingMinor: 100_000,
  currency: 'USD',
};

const schedule: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 },
    { name: 'silver', fromCount: 2, flatMinor: 40_000, marginShare: 0 },
  ],
};

const program: Program = {
  id: programId(1),
  name: 'referral',
  openedOn: day(2024, 1, 1),
  versions: [{ version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'x' }],
};

const catalog: Catalog = unwrap(
  buildCatalog([program], [{ program: programId(1), version: 1, schedule }]),
);

function party(id: number): Party {
  return {
    id: carrierId(id),
    legalName: `Carrier ${id}`,
    motorCarrierNumber: `MC90000${id}`,
    dotNumber: `550000${id}`,
    authorityStatus: 'active',
    remit: { line1: `${id} Main St`, city: 'Joliet', state: 'IL', postalCode: '60431' },
    bank: undefined,
    powerUnits: 1,
  };
}

function referral(invitee: number, activation: string): JournalDraft[] {
  return [
    {
      at: AT,
      kind: 'referral_opened',
      key: `prg_00000001:${carrierId(invitee)}`,
      payload: { program: programId(1), invitee: carrierId(invitee), recordedOn: '2025-01-05' },
    },
    {
      at: AT,
      kind: 'referral_attributed',
      key: `prg_00000001:${carrierId(invitee)}`,
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

const request: CycleRequest = {
  program: programId(1),
  period: interval(day(2025, 11, 1), day(2025, 12, 1)),
  cutOn: day(2025, 12, 2),
  currency: 'USD',
  programYearFrom: day(2025, 1, 1),
};

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'close'));
  unwrap(store.commit(unwrap(fileCarrier(context, party(1)))));
  const enrolled = unwrap(
    enrolAdvocate(context, { carrier: carrierId(1), program: programId(1), from: day(2025, 1, 1) }),
  );
  unwrap(store.commit(enrolled.drafts));
});

describe('qualifyPass', () => {
  it('qualifies every attributed referral that met its count', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
      ]),
    );
    expect(unwrap(qualifyPass(context, catalog, programId(1)))).toBe(1);
    expect(store.referrals.get('prg_00000001:cxr_00000009')!.state).toBe('qualified');
  });

  it('leaves a referral that is short alone', () => {
    unwrap(store.commit([...referral(9, '2025-02-01'), load(1, 9, '2025-02-10')]));
    expect(unwrap(qualifyPass(context, catalog, programId(1)))).toBe(0);
    expect(store.referrals.get('prg_00000001:cxr_00000009')!.state).toBe('attributed');
  });

  it('qualifies nothing twice', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
      ]),
    );
    unwrap(qualifyPass(context, catalog, programId(1)));
    expect(unwrap(qualifyPass(context, catalog, programId(1)))).toBe(0);
  });
});

describe('qualifiedReferralsOf', () => {
  it('gathers what the advocate holds inside the program year', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
      ]),
    );
    unwrap(qualifyPass(context, catalog, programId(1)));
    const found = unwrap(
      qualifiedReferralsOf(context, catalog, advocateId(1), programId(1), PROGRAM_YEAR),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.margin.minor).toBe(100_000);
  });

  it('leaves out a referral that qualified in another year', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
      ]),
    );
    unwrap(qualifyPass(context, catalog, programId(1)));
    const otherYear = interval(day(2026, 1, 1), day(2027, 1, 1));
    expect(
      unwrap(qualifiedReferralsOf(context, catalog, advocateId(1), programId(1), otherYear)),
    ).toEqual([]);
  });
});

describe('accrualPass', () => {
  it('posts the ladder result for every enrolled advocate', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
      ]),
    );
    unwrap(qualifyPass(context, catalog, programId(1)));
    expect(unwrap(accrualPass(context, catalog, request, PROGRAM_YEAR))).toBe(1);
    expect(positionOf(context, advocateId(1), 'USD').minor).toBe(25_000);
  });

  it('posts nothing on a second pass over an unchanged year', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
      ]),
    );
    unwrap(qualifyPass(context, catalog, programId(1)));
    unwrap(accrualPass(context, catalog, request, PROGRAM_YEAR));
    expect(unwrap(accrualPass(context, catalog, request, PROGRAM_YEAR))).toBe(0);
  });
});

describe('clawbackPass', () => {
  it('reverses a referral whose carrier stopped hauling', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-02-11'),
      ]),
    );
    unwrap(qualifyPass(context, catalog, programId(1)));
    expect(unwrap(clawbackPass(context, catalog, programId(1)))).toBe(1);
    expect(store.referrals.get('prg_00000001:cxr_00000009')!.state).toBe('reversed');
  });

  it('leaves a referral that kept hauling alone', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
        load(3, 9, '2025-05-10'),
        load(4, 9, '2025-07-10'),
      ]),
    );
    unwrap(qualifyPass(context, catalog, programId(1)));
    expect(unwrap(clawbackPass(context, catalog, programId(1)))).toBe(0);
  });
});

describe('runCycle', () => {
  it('takes a referral all the way to a settlement line', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
        load(3, 9, '2025-05-10'),
        load(4, 9, '2025-07-10'),
      ]),
    );
    const report = unwrap(runCycle(context, catalog, request, PROGRAM_YEAR));
    expect(report.qualified).toBe(1);
    expect(report.clawedBack).toBe(0);
    const line = lineFor(report.settlement.batch, advocateId(1));
    expect(line!.payable.minor).toBe(25_000);
  });

  it('leaves nothing payable when the referral was clawed back', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-02-11'),
      ]),
    );
    const report = unwrap(runCycle(context, catalog, request, PROGRAM_YEAR));
    expect(report.clawedBack).toBe(1);
    expect(positionOf(context, advocateId(1), 'USD').minor).toBe(0);
  });

  it('crosses a tier and true ups the earlier referral', () => {
    unwrap(
      store.commit([
        ...referral(9, '2025-02-01'),
        ...referral(8, '2025-04-01'),
        load(1, 9, '2025-02-10'),
        load(2, 9, '2025-03-10'),
        load(3, 9, '2025-05-10'),
        load(4, 9, '2025-07-10'),
        load(5, 8, '2025-04-10'),
        load(6, 8, '2025-05-10'),
        load(7, 8, '2025-07-10'),
        load(8, 8, '2025-09-10'),
      ]),
    );
    const report = unwrap(runCycle(context, catalog, request, PROGRAM_YEAR));
    expect(report.qualified).toBe(2);
    expect(positionOf(context, advocateId(1), 'USD').minor).toBe(80_000);
  });

  it('writes a batch that folds into the store', () => {
    unwrap(store.commit([...referral(9, '2025-02-01'), load(1, 9, '2025-02-10')]));
    const report = unwrap(runCycle(context, catalog, request, PROGRAM_YEAR));
    expect(store.batches.get(report.settlement.batch.id)!.state).toBe('cut');
  });

  it('runs cleanly over a program with nothing in it', () => {
    const report = unwrap(runCycle(context, catalog, request, PROGRAM_YEAR));
    expect(report.qualified).toBe(0);
    expect(report.settlement.batch.lines).toEqual([]);
  });
});

describe('undatedAccruals', () => {
  it('is empty for an advocate whose postings all carry a day', () => {
    expect(undatedAccruals(context, advocateId(1))).toEqual([]);
  });
});
