import { beforeEach, describe, expect, it } from 'vitest';
import { carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  deliveredMarginOf,
  loadOf,
  qualificationDrafts,
  qualifyReferral,
  shortfallOf,
} from '../../src/service/qualificationService.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 7, 1);
const ACTIVATION = day(2025, 3, 1);

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

function catalogWith(overrides: Partial<ProgramRules> = {}) {
  const program: Program = {
    id: programId(1),
    name: 'referral',
    openedOn: day(2024, 1, 1),
    versions: [
      { version: 1, effectiveFrom: day(2024, 1, 1), rules: { ...rules, ...overrides }, note: 'x' },
    ],
  };
  return unwrap(buildCatalog([program], [{ program: programId(1), version: 1, schedule }]));
}

const catalog = catalogWith();

function load(sequence: number, deliveredOn: string, marginMinor = 50_000): JournalDraft {
  return {
    at: AT,
    kind: 'load_delivered',
    key: `lod_${sequence}`,
    payload: {
      load: `lod_${sequence}`,
      carrier: carrierId(9),
      proNumber: `PL-${sequence}`,
      deliveredOn,
      lineHaulMinor: 200_000 + marginMinor,
      carrierPayMinor: 200_000,
      currency: 'USD',
      originState: 'IL',
      destinationState: 'TX',
    },
  };
}

let store: Store;
let context: Context;

const request = {
  program: programId(1),
  invitee: carrierId(9),
  effectiveActivation: ACTIVATION,
};

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'settlement'));
  unwrap(
    store.commit([
      {
        at: AT,
        kind: 'referral_opened',
        key: 'prg_00000001:cxr_00000009',
        payload: { program: programId(1), invitee: carrierId(9), recordedOn: '2025-02-01' },
      },
      {
        at: AT,
        kind: 'referral_attributed',
        key: 'prg_00000001:cxr_00000009',
        payload: {
          program: programId(1),
          invitee: carrierId(9),
          advocate: 'adv_00000001',
          effectiveActivation: '2025-03-01',
        },
      },
    ]),
  );
});

describe('loadOf', () => {
  it('reads a row back into a load', () => {
    unwrap(store.commit([load(1, '2025-03-10')]));
    const read = unwrap(loadOf(store.loads.get('lod_1')!));
    expect(read.proNumber).toBe('PL-1');
    expect(read.deliveredOn).toEqual(day(2025, 3, 10));
    expect(read.currency).toBe('USD');
  });

  it('refuses a row whose delivery day cannot be read', () => {
    unwrap(store.commit([load(1, '2025-03-10')]));
    const row = { ...store.loads.get('lod_1')!, deliveredOn: 'soon' };
    expect(isErr(loadOf(row))).toBe(true);
  });
});

describe('qualifyReferral', () => {
  it('qualifies on the third delivered load', () => {
    unwrap(store.commit([load(1, '2025-03-05'), load(2, '2025-03-20'), load(3, '2025-04-02')]));
    const outcome = unwrap(qualifyReferral(context, catalog, request));
    expect(outcome.qualified).toBe(true);
    if (outcome.qualified) {
      expect(outcome.qualifiedOn).toEqual(day(2025, 4, 2));
    }
  });

  it('reports how short it is', () => {
    unwrap(store.commit([load(1, '2025-03-05')]));
    expect(shortfallOf(unwrap(qualifyReferral(context, catalog, request)))).toBe(2);
  });

  it('counts the margin of every load in the window', () => {
    unwrap(
      store.commit([
        load(1, '2025-03-05'),
        load(2, '2025-03-20'),
        load(3, '2025-04-02'),
        load(4, '2025-04-20'),
      ]),
    );
    const outcome = unwrap(qualifyReferral(context, catalog, request));
    expect(deliveredMarginOf(outcome).minor).toBe(200_000);
  });

  it('leaves out a load delivered after the window closed', () => {
    unwrap(store.commit([load(1, '2025-03-05'), load(2, '2025-03-20'), load(3, '2025-09-02')]));
    expect(unwrap(qualifyReferral(context, catalog, request)).qualified).toBe(false);
  });

  it('moves with the qualifying count in the program version', () => {
    unwrap(store.commit([load(1, '2025-03-05'), load(2, '2025-03-20')]));
    const looser = catalogWith({ qualifyingLoadCount: 2 });
    expect(unwrap(qualifyReferral(context, looser, request)).qualified).toBe(true);
    expect(unwrap(qualifyReferral(context, catalog, request)).qualified).toBe(false);
  });

  it('fails for a program the catalogue does not hold', () => {
    expect(isErr(qualifyReferral(context, catalog, { ...request, program: programId(9) }))).toBe(
      true,
    );
  });

  it('qualifies nothing for a carrier with no loads', () => {
    expect(unwrap(qualifyReferral(context, catalog, request)).qualified).toBe(false);
  });
});

describe('qualificationDrafts', () => {
  it('writes the qualification with the margin and the count', () => {
    unwrap(store.commit([load(1, '2025-03-05'), load(2, '2025-03-20'), load(3, '2025-04-02')]));
    const outcome = unwrap(qualifyReferral(context, catalog, request));
    const drafts = unwrap(qualificationDrafts(context, request, outcome));
    expect(drafts[0]!.payload['qualifiedOn']).toBe('2025-04-02');
    expect(drafts[0]!.payload['deliveredMarginMinor']).toBe(150_000);
    expect(drafts[0]!.payload['loadCount']).toBe(3);
    unwrap(store.commit(drafts));
    expect(store.referrals.get('prg_00000001:cxr_00000009')!.state).toBe('qualified');
  });

  it('writes nothing when the referral is short', () => {
    const outcome = unwrap(qualifyReferral(context, catalog, request));
    const r = qualificationDrafts(context, request, outcome);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('qualification_not_met');
    }
  });

  it('refuses to qualify a referral with no advocate', () => {
    const bare = Store.empty();
    const other = unwrap(contextFor(bare, fixedClock(AT), 'UTC', 'settlement'));
    unwrap(
      bare.commit([
        {
          at: AT,
          kind: 'referral_opened',
          key: 'prg_00000001:cxr_00000009',
          payload: { program: programId(1), invitee: carrierId(9), recordedOn: '2025-02-01' },
        },
        load(1, '2025-03-05'),
        load(2, '2025-03-20'),
        load(3, '2025-04-02'),
      ]),
    );
    const outcome = unwrap(qualifyReferral(other, catalog, request));
    const r = qualificationDrafts(other, request, outcome);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('qualification_unattributed');
    }
  });

  it('refuses a referral that was never opened', () => {
    const bare = Store.empty();
    const other = unwrap(contextFor(bare, fixedClock(AT), 'UTC', 'settlement'));
    unwrap(bare.commit([load(1, '2025-03-05'), load(2, '2025-03-20'), load(3, '2025-04-02')]));
    const outcome = unwrap(qualifyReferral(other, catalog, request));
    expect(isErr(qualificationDrafts(other, request, outcome))).toBe(true);
  });
});
