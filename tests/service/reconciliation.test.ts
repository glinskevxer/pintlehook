import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import { qualifyPass, accrualPass, type CycleRequest } from '../../src/service/cycle.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import {
  balanced,
  describeReconciliation,
  reconcileAdvocate,
  reconcileProgram,
} from '../../src/service/reconciliation.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 11, 2);
const PROGRAM_YEAR = interval(day(2025, 1, 1), day(2026, 1, 1));
const YEAR_FROM = day(2025, 1, 1);

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
  tiers: [{ name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 }],
};

const program: Program = {
  id: programId(1),
  name: 'referral',
  openedOn: day(2024, 1, 1),
  versions: [{ version: 1, effectiveFrom: day(2024, 1, 1), rules, note: 'x' }],
};

const catalog = unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));

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

function referral(invitee: number): JournalDraft[] {
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
        effectiveActivation: '2025-02-01',
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

const request: CycleRequest = {
  program: programId(1),
  period: interval(day(2025, 11, 1), day(2025, 12, 1)),
  cutOn: day(2025, 12, 2),
  currency: 'USD',
  programYearFrom: YEAR_FROM,
};

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'close'));
  unwrap(store.commit(unwrap(fileCarrier(context, party(1)))));
  const enrolled = unwrap(
    enrolAdvocate(context, { carrier: carrierId(1), program: programId(1), from: day(2025, 1, 1) }),
  );
  unwrap(store.commit(enrolled.drafts));
});

describe('an advocate with nothing', () => {
  it('agrees at zero', () => {
    const row = unwrap(
      reconcileAdvocate(
        context,
        catalog,
        advocateId(1),
        programId(1),
        PROGRAM_YEAR,
        YEAR_FROM,
        'USD',
      ),
    );
    expect(row.agrees).toBe(true);
    expect(row.ladderSays.minor).toBe(0);
    expect(row.accrualsSay.minor).toBe(0);
  });
});

describe('after the accrual pass has run', () => {
  beforeEach(() => {
    unwrap(store.commit([...referral(9), load(1, 9, '2025-02-10'), load(2, 9, '2025-03-10')]));
    unwrap(qualifyPass(context, catalog, programId(1)));
    unwrap(accrualPass(context, catalog, request, PROGRAM_YEAR));
  });

  it('agrees for the advocate', () => {
    const row = unwrap(
      reconcileAdvocate(
        context,
        catalog,
        advocateId(1),
        programId(1),
        PROGRAM_YEAR,
        YEAR_FROM,
        'USD',
      ),
    );
    expect(row.agrees).toBe(true);
    expect(row.ladderSays.minor).toBe(25_000);
    expect(row.accrualsSay.minor).toBe(25_000);
  });

  it('agrees across the program', () => {
    const report = unwrap(
      reconcileProgram(context, catalog, programId(1), PROGRAM_YEAR, YEAR_FROM, 'USD'),
    );
    expect(balanced(report)).toBe(true);
    expect(report.rows).toHaveLength(1);
    expect(describeReconciliation(report)).toContain('everything agrees');
  });
});

describe('when the tables disagree', () => {
  beforeEach(() => {
    unwrap(store.commit([...referral(9), load(1, 9, '2025-02-10'), load(2, 9, '2025-03-10')]));
    unwrap(qualifyPass(context, catalog, programId(1)));
    unwrap(accrualPass(context, catalog, request, PROGRAM_YEAR));
  });

  it('names the difference when a stray posting is added', () => {
    unwrap(
      store.commit([
        {
          at: AT,
          kind: 'accrual_posted',
          key: 'acr_stray',
          payload: {
            accrual: 'acr_stray',
            advocate: advocateId(1),
            program: programId(1),
            referralKey: 'prg_00000001:cxr_00000009',
            kind: 'adjustment',
            postedOn: '2025-06-01',
            programYearFrom: '2025-01-01',
            amountMinor: 9_900,
            currency: 'USD',
            reverses: '',
            note: 'somebody edited this by hand',
          },
        },
      ]),
    );
    const row = unwrap(
      reconcileAdvocate(
        context,
        catalog,
        advocateId(1),
        programId(1),
        PROGRAM_YEAR,
        YEAR_FROM,
        'USD',
      ),
    );
    expect(row.agrees).toBe(false);
    expect(row.difference.minor).toBe(-9_900);
    expect(row.ladderSays.minor).toBe(25_000);
    expect(row.accrualsSay.minor).toBe(34_900);
  });

  it('counts the disagreements and the worst one', () => {
    unwrap(
      store.commit([
        {
          at: AT,
          kind: 'accrual_posted',
          key: 'acr_stray',
          payload: {
            accrual: 'acr_stray',
            advocate: advocateId(1),
            program: programId(1),
            referralKey: 'prg_00000001:cxr_00000009',
            kind: 'adjustment',
            postedOn: '2025-06-01',
            programYearFrom: '2025-01-01',
            amountMinor: -4_100,
            currency: 'USD',
            reverses: '',
            note: 'a hand adjustment nobody wrote down',
          },
        },
      ]),
    );
    const report = unwrap(
      reconcileProgram(context, catalog, programId(1), PROGRAM_YEAR, YEAR_FROM, 'USD'),
    );
    expect(report.disagreements).toBe(1);
    expect(report.worst.minor).toBe(4_100);
    expect(describeReconciliation(report)).toContain('1 of 1 advocates disagree');
  });
});

describe('failures', () => {
  it('fails for a program the catalogue does not hold', () => {
    expect(
      isErr(
        reconcileAdvocate(
          context,
          catalog,
          advocateId(1),
          programId(9),
          PROGRAM_YEAR,
          YEAR_FROM,
          'USD',
        ),
      ),
    ).toBe(true);
  });

  it('fails when the program year predates every version', () => {
    expect(
      isErr(reconcileProgram(context, catalog, programId(1), PROGRAM_YEAR, day(2022, 1, 1), 'USD')),
    ).toBe(true);
  });
});
