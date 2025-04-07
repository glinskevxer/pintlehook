import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Program, ProgramRules } from '../../src/domain/program.js';
import type { RewardSchedule } from '../../src/domain/schedule.js';
import { buildCatalog } from '../../src/service/catalog.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  actionList,
  buildExceptions,
  countBySeverity,
  lapsedQualifyingWindows,
  openEligibilityFlags,
  requireProgram,
  reversedReferrals,
  unattributedReferrals,
} from '../../src/service/exceptionService.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 9, 1);

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

function opened(invitee: number, recordedOn: string): JournalDraft {
  return {
    at: AT,
    kind: 'referral_opened',
    key: `prg_00000001:${carrierId(invitee)}`,
    payload: { program: programId(1), invitee: carrierId(invitee), recordedOn },
  };
}

function attributed(invitee: number, activation: string): JournalDraft {
  return {
    at: AT,
    kind: 'referral_attributed',
    key: `prg_00000001:${carrierId(invitee)}`,
    payload: {
      program: programId(1),
      invitee: carrierId(invitee),
      advocate: advocateId(1),
      effectiveActivation: activation,
    },
  };
}

const carrierFiled: JournalDraft = {
  at: AT,
  kind: 'carrier_filed',
  key: carrierId(1),
  payload: {
    carrier: carrierId(1),
    legalName: 'Brannan Hauling',
    motorCarrierNumber: 'MC884210',
    dotNumber: '3126540',
    authorityStatus: 'active',
    remitDigest: 'r',
    bankDigest: 'b',
    powerUnits: 1,
  },
};

const advocateEnrolled: JournalDraft = {
  at: AT,
  kind: 'advocate_enrolled',
  key: advocateId(1),
  payload: {
    advocate: advocateId(1),
    carrier: carrierId(1),
    program: programId(1),
    referralCode: 'AB3K9ZQ',
    from: '2025-01-01',
  },
};

function flagRaised(flag: string, on: string): JournalDraft {
  return {
    at: AT,
    kind: 'eligibility_flag_raised',
    key: advocateId(1),
    payload: { advocate: advocateId(1), flag, raisedOn: on },
  };
}

function flagCleared(flag: string, on: string): JournalDraft {
  return {
    at: AT,
    kind: 'eligibility_flag_cleared',
    key: advocateId(1),
    payload: { advocate: advocateId(1), flag, clearedOn: on },
  };
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
});

describe('unattributedReferrals', () => {
  it('raises one per recorded referral', () => {
    unwrap(store.commit([opened(9, '2025-02-01'), opened(8, '2025-03-01')]));
    expect(unattributedReferrals(context)).toHaveLength(2);
  });

  it('raises nothing once a referral is attributed', () => {
    unwrap(store.commit([opened(9, '2025-02-01'), attributed(9, '2025-03-01')]));
    expect(unattributedReferrals(context)).toHaveLength(0);
  });

  it('dates the exception to the day the referral was recorded', () => {
    unwrap(store.commit([opened(9, '2025-02-01')]));
    expect(unattributedReferrals(context)[0]!.raisedOn).toEqual(day(2025, 2, 1));
  });
});

describe('lapsedQualifyingWindows', () => {
  it('raises one once the window has closed', () => {
    unwrap(store.commit([opened(9, '2025-02-01'), attributed(9, '2025-03-01')]));
    const found = unwrap(lapsedQualifyingWindows(context, catalog, programId(1)));
    expect(found).toHaveLength(1);
    expect(found[0]!.raisedOn).toEqual(day(2025, 6, 29));
  });

  it('raises nothing while the window is open', () => {
    unwrap(store.commit([opened(9, '2025-02-01'), attributed(9, '2025-03-01')]));
    const early = unwrap(
      contextFor(store, fixedClock(Date.UTC(2025, 3, 1)), 'America/Chicago', 'desk'),
    );
    expect(unwrap(lapsedQualifyingWindows(early, catalog, programId(1)))).toHaveLength(0);
  });

  it('leaves other programs alone', () => {
    unwrap(store.commit([opened(9, '2025-02-01'), attributed(9, '2025-03-01')]));
    expect(unwrap(lapsedQualifyingWindows(context, catalog, programId(2)))).toHaveLength(0);
  });

  it('fails when the activation predates every program version', () => {
    unwrap(store.commit([opened(9, '2022-02-01'), attributed(9, '2022-03-01')]));
    expect(isErr(lapsedQualifyingWindows(context, catalog, programId(1)))).toBe(true);
  });
});

describe('reversedReferrals', () => {
  it('raises one per reversal', () => {
    unwrap(
      store.commit([
        opened(9, '2025-02-01'),
        attributed(9, '2025-03-01'),
        {
          at: AT,
          kind: 'referral_qualified',
          key: 'prg_00000001:cxr_00000009',
          payload: { program: programId(1), invitee: carrierId(9), qualifiedOn: '2025-05-01' },
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
    const found = reversedReferrals(context);
    expect(found).toHaveLength(1);
    expect(found[0]!.raisedOn).toEqual(day(2025, 8, 1));
  });

  it('raises nothing with no reversals', () => {
    expect(reversedReferrals(context)).toHaveLength(0);
  });
});

describe('openEligibilityFlags', () => {
  beforeEach(() => {
    unwrap(store.commit([carrierFiled, advocateEnrolled]));
  });

  it('raises one per advocate with an open flag', () => {
    unwrap(store.commit([flagRaised('w9_missing', '2025-03-01')]));
    const found = openEligibilityFlags(context, programId(1));
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('w9_missing');
  });

  it('raises nothing once the flag is cleared', () => {
    unwrap(
      store.commit([
        flagRaised('w9_missing', '2025-03-01'),
        flagCleared('w9_missing', '2025-04-01'),
      ]),
    );
    expect(openEligibilityFlags(context, programId(1))).toHaveLength(0);
  });

  it('raises nothing for an advocate with no flags', () => {
    expect(openEligibilityFlags(context, programId(1))).toHaveLength(0);
  });
});

describe('buildExceptions', () => {
  it('gathers every kind into one ordered list', () => {
    unwrap(
      store.commit([opened(9, '2025-02-01'), opened(8, '2025-03-01'), attributed(8, '2025-03-01')]),
    );
    const kinds = unwrap(buildExceptions(context, catalog, programId(1))).map((e) => e.kind);
    expect(kinds).toContain('unattributed_referral');
    expect(kinds).toContain('qualifying_window_lapsed');
  });

  it('does not double a subject when the run happens twice', () => {
    unwrap(store.commit([opened(9, '2025-02-01')]));
    const once = unwrap(buildExceptions(context, catalog, programId(1)));
    const twice = unwrap(buildExceptions(context, catalog, programId(1)));
    expect(twice).toHaveLength(once.length);
  });

  it('gives an empty list for an empty store', () => {
    expect(unwrap(buildExceptions(context, catalog, programId(1)))).toEqual([]);
  });

  it('passes a lapse failure through', () => {
    unwrap(store.commit([opened(9, '2022-02-01'), attributed(9, '2022-03-01')]));
    expect(isErr(buildExceptions(context, catalog, programId(1)))).toBe(true);
  });
});

describe('actionList and countBySeverity', () => {
  it('keeps only what somebody has to work', () => {
    unwrap(
      store.commit([opened(9, '2025-02-01'), opened(8, '2025-03-01'), attributed(8, '2025-03-01')]),
    );
    const found = unwrap(buildExceptions(context, catalog, programId(1)));
    expect(countBySeverity(found).review).toBeGreaterThan(0);
    expect(actionList(found).every((exception) => exception.clearedOn === undefined)).toBe(true);
  });

  it('counts nothing for an empty list', () => {
    expect(countBySeverity([])).toEqual({ action: 0, review: 0, note: 0 });
  });
});

describe('requireProgram', () => {
  it('accepts a program in the catalogue', () => {
    expect(unwrap(requireProgram(catalog, programId(1)))).toBe(programId(1));
  });

  it('refuses one that is not', () => {
    expect(isErr(requireProgram(catalog, programId(9)))).toBe(true);
  });
});
