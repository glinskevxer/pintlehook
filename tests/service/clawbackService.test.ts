import { beforeEach, describe, expect, it } from 'vitest';
import { carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog } from '../../src/service/catalog.js';
import {
  assessReferral,
  claimOf,
  clawbackDrafts,
  marginAfterClaims,
  toleranceOf,
} from '../../src/service/clawbackService.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { money } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 11, 1);
const QUALIFIED = day(2025, 1, 6);

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

function load(sequence: number, deliveredOn: string): JournalDraft {
  return {
    at: AT,
    kind: 'load_delivered',
    key: `lod_${sequence}`,
    payload: {
      load: `lod_${sequence}`,
      carrier: carrierId(9),
      proNumber: `PL-${sequence}`,
      deliveredOn,
      lineHaulMinor: 250_000,
      carrierPayMinor: 200_000,
      currency: 'USD',
      originState: 'IL',
      destinationState: 'TX',
    },
  };
}

function claim(
  sequence: number,
  raisedOn: string,
  amountMinor: number,
  disposition = 'charged_to_carrier',
): JournalDraft {
  return {
    at: AT,
    kind: 'claim_stated',
    key: `clm_${sequence}`,
    payload: {
      claim: `clm_${sequence}`,
      load: `lod_${sequence}`,
      raisedOn,
      disposition,
      amountMinor,
      currency: 'USD',
    },
  };
}

const referralOpened: JournalDraft = {
  at: AT,
  kind: 'referral_opened',
  key: 'prg_00000001:cxr_00000009',
  payload: { program: programId(1), invitee: carrierId(9), recordedOn: '2024-12-01' },
};

const referralQualified: JournalDraft = {
  at: AT,
  kind: 'referral_qualified',
  key: 'prg_00000001:cxr_00000009',
  payload: { program: programId(1), invitee: carrierId(9), qualifiedOn: '2025-01-06' },
};

let store: Store;
let context: Context;

const request = {
  program: programId(1),
  invitee: carrierId(9),
  qualifiedOn: QUALIFIED,
  deliveredMargin: money('USD', 400_000),
};

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'settlement'));
  unwrap(
    store.commit([
      referralOpened,
      {
        at: AT,
        kind: 'referral_attributed',
        key: 'prg_00000001:cxr_00000009',
        payload: {
          program: programId(1),
          invitee: carrierId(9),
          advocate: 'adv_00000001',
          effectiveActivation: '2024-12-05',
        },
      },
      referralQualified,
      load(1, '2025-01-20'),
      load(2, '2025-04-01'),
      load(3, '2025-06-01'),
    ]),
  );
});

describe('claimOf', () => {
  it('reads a row back into a claim', () => {
    unwrap(store.commit([claim(1, '2025-03-01', 10_000)]));
    const read = unwrap(claimOf(store.claims.get('clm_1')!));
    expect(read.raisedOn).toEqual(day(2025, 3, 1));
    expect(read.disposition).toBe('charged_to_carrier');
  });

  it('refuses a row with no raised day', () => {
    unwrap(store.commit([claim(1, '2025-03-01', 10_000)]));
    const row = { ...store.claims.get('clm_1')!, raisedOn: '' };
    const r = claimOf(row);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('claim_raised_missing');
    }
  });
});

describe('a referral that holds up', () => {
  it('claws back nothing', () => {
    const assessment = unwrap(assessReferral(context, catalog, request));
    expect(assessment.retention.state).toBe('satisfied');
    expect(assessment.clawback.clawed).toBe(false);
  });

  it('reports the margin and the tolerance', () => {
    const assessment = unwrap(assessReferral(context, catalog, request));
    expect(marginAfterClaims(assessment).minor).toBe(400_000);
    expect(toleranceOf(assessment, 'USD').minor).toBe(100_000);
  });

  it('writes no reversal', () => {
    const assessment = unwrap(assessReferral(context, catalog, request));
    const r = clawbackDrafts(context, request, assessment);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('clawback_not_triggered');
    }
  });
});

describe('retention failure', () => {
  it('claws back when a checkpoint carried nothing', () => {
    const bare = Store.empty();
    const other = unwrap(contextFor(bare, fixedClock(AT), 'UTC', 'settlement'));
    unwrap(bare.commit([referralOpened, referralQualified, load(1, '2025-01-20')]));
    const assessment = unwrap(assessReferral(other, catalog, request));
    expect(assessment.retention.state).toBe('failed');
    expect(assessment.clawback.reason).toBe('retention_failed');
  });

  it('claws back when the authority was lost inside the window', () => {
    const assessment = unwrap(
      assessReferral(context, catalog, { ...request, authorityLostOn: day(2025, 3, 1) }),
    );
    expect(assessment.clawback.clawed).toBe(true);
    expect(assessment.clawback.on).toEqual(day(2025, 3, 1));
  });

  it('writes the reversal with its reason and day', () => {
    const assessment = unwrap(
      assessReferral(context, catalog, { ...request, authorityLostOn: day(2025, 3, 1) }),
    );
    const drafts = unwrap(clawbackDrafts(context, request, assessment));
    expect(drafts[0]!.payload['reversedOn']).toBe('2025-03-01');
    expect(drafts[0]!.payload['reason']).toBe('retention_failed');
    unwrap(store.commit(drafts));
    expect(store.referrals.get('prg_00000001:cxr_00000009')!.state).toBe('reversed');
  });
});

describe('claim chargeback', () => {
  it('tolerates a claim inside the tolerance', () => {
    unwrap(store.commit([claim(1, '2025-03-01', 90_000)]));
    expect(unwrap(assessReferral(context, catalog, request)).clawback.clawed).toBe(false);
  });

  it('claws back once the tolerance is passed', () => {
    unwrap(store.commit([claim(1, '2025-03-01', 100_001)]));
    const assessment = unwrap(assessReferral(context, catalog, request));
    expect(assessment.clawback.reason).toBe('claim_chargeback');
    expect(assessment.clawback.on).toEqual(day(2025, 3, 1));
  });

  it('ignores an absorbed claim', () => {
    unwrap(store.commit([claim(1, '2025-03-01', 900_000, 'absorbed')]));
    expect(unwrap(assessReferral(context, catalog, request)).clawback.clawed).toBe(false);
  });

  it('follows the tolerance the caller passed', () => {
    unwrap(store.commit([claim(1, '2025-03-01', 90_000)]));
    const assessment = unwrap(
      assessReferral(context, catalog, { ...request, claimTolerance: 1000 }),
    );
    expect(assessment.clawback.clawed).toBe(true);
  });

  it('takes the earlier of a claim and a retention failure', () => {
    unwrap(store.commit([claim(1, '2025-06-15', 200_000)]));
    const assessment = unwrap(
      assessReferral(context, catalog, { ...request, authorityLostOn: day(2025, 2, 1) }),
    );
    expect(assessment.clawback.reason).toBe('retention_failed');
  });
});

describe('failures', () => {
  it('fails for a program the catalogue does not hold', () => {
    expect(isErr(assessReferral(context, catalog, { ...request, program: programId(9) }))).toBe(
      true,
    );
  });

  it('refuses to reverse a referral that never qualified', () => {
    const bare = Store.empty();
    const other = unwrap(contextFor(bare, fixedClock(AT), 'UTC', 'settlement'));
    unwrap(bare.commit([referralOpened, load(1, '2025-01-20')]));
    const assessment = unwrap(assessReferral(other, catalog, request));
    const r = clawbackDrafts(other, request, assessment);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('clawback_not_qualified');
    }
  });

  it('refuses to reverse a referral nobody opened', () => {
    const bare = Store.empty();
    const other = unwrap(contextFor(bare, fixedClock(AT), 'UTC', 'settlement'));
    const assessment = unwrap(
      assessReferral(other, catalog, { ...request, authorityLostOn: day(2025, 3, 1) }),
    );
    expect(isErr(clawbackDrafts(other, request, assessment))).toBe(true);
  });

  it('refuses a margin in another currency', () => {
    const r = assessReferral(context, catalog, {
      ...request,
      deliveredMargin: money('CAD', 400_000),
    });
    expect(isErr(r)).toBe(true);
  });
});
