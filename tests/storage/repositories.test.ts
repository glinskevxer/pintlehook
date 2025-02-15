import { beforeEach, describe, expect, it } from 'vitest';
import type { JournalDraft } from '../../src/storage/journal.js';
import {
  accrualsForReferral,
  accrualsInProgramYear,
  accrualsOfAdvocate,
  accrualsUpTo,
  advocateByCode,
  advocateById,
  advocatesOfCarrier,
  carrierById,
  carrierByMotorCarrierNumber,
  claimsForCarrier,
  claimsForLoad,
  deliveredLoadsIn,
  enrolledAdvocates,
  hasOpenFlags,
  loadsOfCarrier,
  openFlagsOf,
  referralByKey,
  referralsInState,
  referralsOfAdvocate,
  touchesForAdvocate,
  touchesForInvitee,
} from '../../src/storage/repositories.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 4, 1, 12, 0, 0);

function draft(kind: string, key: string, payload: Record<string, unknown>): JournalDraft {
  return { at: AT, kind, key, payload };
}

let store: Store;

beforeEach(() => {
  store = Store.empty();
  unwrap(
    store.commit([
      draft('carrier_filed', 'cxr_1', {
        carrier: 'cxr_1',
        legalName: 'Brannan Hauling',
        motorCarrierNumber: 'MC884210',
        dotNumber: '3126540',
        authorityStatus: 'active',
        remitDigest: 'r1',
        bankDigest: 'b1',
        powerUnits: 2,
      }),
      draft('advocate_enrolled', 'adv_1', {
        advocate: 'adv_1',
        carrier: 'cxr_1',
        program: 'prg_1',
        referralCode: 'AB3K9ZQ',
        from: '2025-01-01',
      }),
      draft('advocate_enrolled', 'adv_2', {
        advocate: 'adv_2',
        carrier: 'cxr_1',
        program: 'prg_1',
        referralCode: 'QW7X2MB',
        from: '2025-01-01',
      }),
      draft('advocate_withdrawn', 'adv_2', {
        advocate: 'adv_2',
        until: '2025-04-01',
        reason: 'withdrew',
      }),
      draft('touch_recorded', 'tch_1', {
        touch: 'tch_1',
        advocate: 'adv_1',
        invitee: 'cxr_9',
        channel: 'card',
        presentedCode: 'AB3K9ZQ',
        at: AT + 2000,
        sourceReference: 'f:1',
      }),
      draft('touch_recorded', 'tch_2', {
        touch: 'tch_2',
        advocate: 'adv_1',
        invitee: 'cxr_9',
        channel: 'link',
        presentedCode: 'AB3K9ZQ',
        at: AT,
        sourceReference: 'f:2',
      }),
      draft('referral_opened', 'prg_1:cxr_9', {
        program: 'prg_1',
        invitee: 'cxr_9',
        recordedOn: '2025-02-01',
      }),
      draft('referral_attributed', 'prg_1:cxr_9', {
        program: 'prg_1',
        invitee: 'cxr_9',
        advocate: 'adv_1',
        effectiveActivation: '2025-03-01',
      }),
    ]),
  );
});

describe('carriers', () => {
  it('reads by identifier', () => {
    expect(unwrap(carrierById(store, 'cxr_1')).legalName).toBe('Brannan Hauling');
    expect(isErr(carrierById(store, 'cxr_9'))).toBe(true);
  });

  it('reads by motor carrier number', () => {
    expect(unwrap(carrierByMotorCarrierNumber(store, 'MC884210')).id).toBe('cxr_1');
    expect(isErr(carrierByMotorCarrierNumber(store, 'MC000001'))).toBe(true);
  });
});

describe('advocates', () => {
  it('reads by identifier and by code', () => {
    expect(unwrap(advocateById(store, 'adv_1')).referralCode).toBe('AB3K9ZQ');
    expect(unwrap(advocateByCode(store, 'QW7X2MB')).id).toBe('adv_2');
    expect(isErr(advocateByCode(store, 'ZZZZZZZ'))).toBe(true);
  });

  it('lists everybody on a carrier', () => {
    expect(advocatesOfCarrier(store, 'cxr_1').map((row) => row.id)).toEqual(['adv_1', 'adv_2']);
  });

  it('leaves the withdrawn out of the enrolled list', () => {
    expect(enrolledAdvocates(store, 'prg_1').map((row) => row.id)).toEqual(['adv_1']);
  });

  it('gives nothing for a program with nobody in it', () => {
    expect(enrolledAdvocates(store, 'prg_9')).toEqual([]);
  });
});

describe('touches', () => {
  it('lists an invitee in time order', () => {
    expect(touchesForInvitee(store, 'cxr_9').map((row) => row.id)).toEqual(['tch_2', 'tch_1']);
  });

  it('lists an advocate', () => {
    expect(touchesForAdvocate(store, 'adv_1')).toHaveLength(2);
  });

  it('gives nothing for somebody with no touches', () => {
    expect(touchesForInvitee(store, 'cxr_8')).toEqual([]);
  });
});

describe('referrals', () => {
  it('reads by program and invitee', () => {
    expect(unwrap(referralByKey(store, 'prg_1', 'cxr_9')).advocate).toBe('adv_1');
    expect(isErr(referralByKey(store, 'prg_1', 'cxr_8'))).toBe(true);
  });

  it('lists by advocate and by state', () => {
    expect(referralsOfAdvocate(store, 'adv_1')).toHaveLength(1);
    expect(referralsInState(store, 'attributed')).toHaveLength(1);
    expect(referralsInState(store, 'qualified')).toEqual([]);
  });
});

describe('loads and claims', () => {
  beforeEach(() => {
    unwrap(
      store.commit([
        draft('load_delivered', 'lod_1', {
          load: 'lod_1',
          carrier: 'cxr_9',
          proNumber: 'PL-1',
          deliveredOn: '2025-03-10',
          lineHaulMinor: 250_000,
          carrierPayMinor: 200_000,
          currency: 'USD',
          originState: 'IL',
          destinationState: 'TX',
        }),
        draft('load_delivered', 'lod_2', {
          load: 'lod_2',
          carrier: 'cxr_9',
          proNumber: 'PL-2',
          deliveredOn: '2025-08-10',
          lineHaulMinor: 250_000,
          carrierPayMinor: 200_000,
          currency: 'USD',
          originState: 'IL',
          destinationState: 'TX',
        }),
        draft('claim_stated', 'clm_1', {
          claim: 'clm_1',
          load: 'lod_1',
          raisedOn: '2025-04-01',
          disposition: 'charged_to_carrier',
          amountMinor: 90_000,
          currency: 'USD',
        }),
      ]),
    );
  });

  it('lists a carrier in delivery order', () => {
    expect(loadsOfCarrier(store, 'cxr_9').map((row) => row.id)).toEqual(['lod_1', 'lod_2']);
  });

  it('keeps only the loads delivered inside a window', () => {
    const window = interval(day(2025, 3, 1), day(2025, 7, 1));
    expect(unwrap(deliveredLoadsIn(store, 'cxr_9', window)).map((row) => row.id)).toEqual([
      'lod_1',
    ]);
  });

  it('leaves a load that is not delivered out of the window', () => {
    unwrap(
      store.commit([
        draft('load_amended', 'lod_1', { load: 'lod_1', field: 'status', value: 'refused' }),
      ]),
    );
    const window = interval(day(2025, 3, 1), day(2025, 7, 1));
    expect(unwrap(deliveredLoadsIn(store, 'cxr_9', window))).toEqual([]);
  });

  it('lists claims by load and by carrier', () => {
    expect(claimsForLoad(store, 'lod_1')).toHaveLength(1);
    expect(claimsForLoad(store, 'lod_2')).toEqual([]);
    expect(claimsForCarrier(store, 'cxr_9')).toHaveLength(1);
    expect(claimsForCarrier(store, 'cxr_1')).toEqual([]);
  });
});

describe('accruals', () => {
  beforeEach(() => {
    unwrap(
      store.commit([
        draft('accrual_posted', 'acr_1', {
          accrual: 'acr_1',
          advocate: 'adv_1',
          program: 'prg_1',
          referralKey: 'prg_1:cxr_9',
          kind: 'base',
          postedOn: '2025-05-01',
          programYearFrom: '2025-01-01',
          amountMinor: 25_000,
          currency: 'USD',
          reverses: '',
          note: 'first bounty',
        }),
        draft('accrual_posted', 'acr_2', {
          accrual: 'acr_2',
          advocate: 'adv_1',
          program: 'prg_1',
          referralKey: 'prg_1:cxr_9',
          kind: 'true_up',
          postedOn: '2025-09-01',
          programYearFrom: '2025-01-01',
          amountMinor: 16_000,
          currency: 'USD',
          reverses: '',
          note: 'silver true up',
        }),
        draft('accrual_posted', 'acr_3', {
          accrual: 'acr_3',
          advocate: 'adv_1',
          program: 'prg_1',
          referralKey: 'prg_1:cxr_8',
          kind: 'base',
          postedOn: '2026-02-01',
          programYearFrom: '2026-01-01',
          amountMinor: 25_000,
          currency: 'USD',
          reverses: '',
          note: 'next year',
        }),
      ]),
    );
  });

  it('lists an advocate in posting order', () => {
    expect(accrualsOfAdvocate(store, 'adv_1').map((row) => row.id)).toEqual([
      'acr_1',
      'acr_2',
      'acr_3',
    ]);
  });

  it('lists one referral', () => {
    expect(accrualsForReferral(store, 'prg_1:cxr_9')).toHaveLength(2);
  });

  it('lists one program year', () => {
    expect(accrualsInProgramYear(store, 'adv_1', '2025-01-01')).toHaveLength(2);
    expect(accrualsInProgramYear(store, 'adv_1', '2026-01-01')).toHaveLength(1);
  });

  it('cuts off at a day', () => {
    expect(unwrap(accrualsUpTo(store, 'adv_1', day(2025, 6, 1)))).toHaveLength(1);
    expect(unwrap(accrualsUpTo(store, 'adv_1', day(2026, 6, 1)))).toHaveLength(3);
  });

  it('gives nothing for an advocate with no postings', () => {
    expect(accrualsOfAdvocate(store, 'adv_2')).toEqual([]);
  });
});

describe('flags', () => {
  it('lists only the open ones, in order', () => {
    unwrap(
      store.commit([
        draft('eligibility_flag_raised', 'adv_1', {
          advocate: 'adv_1',
          flag: 'w9_missing',
          raisedOn: '2025-03-01',
        }),
        draft('eligibility_flag_raised', 'adv_1', {
          advocate: 'adv_1',
          flag: 'under_review',
          raisedOn: '2025-03-02',
        }),
        draft('eligibility_flag_cleared', 'adv_1', {
          advocate: 'adv_1',
          flag: 'w9_missing',
          clearedOn: '2025-04-01',
        }),
      ]),
    );
    expect(openFlagsOf(store, 'adv_1')).toEqual(['under_review']);
    expect(hasOpenFlags(store, 'adv_1')).toBe(true);
    expect(hasOpenFlags(store, 'adv_2')).toBe(false);
  });
});
