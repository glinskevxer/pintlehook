import { describe, expect, it } from 'vitest';
import type { JournalDraft } from '../../src/storage/journal.js';
import { JournalLog } from '../../src/storage/log.js';
import { Store, referralKeyOf } from '../../src/storage/store.js';
import { NO_DAY } from '../../src/storage/rows.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 4, 1, 12, 0, 0);

function draft(kind: string, key: string, payload: Record<string, unknown>): JournalDraft {
  return { at: AT, kind, key, payload };
}

const carrier = draft('carrier_filed', 'cxr_1', {
  carrier: 'cxr_1',
  legalName: 'Brannan Hauling',
  motorCarrierNumber: 'MC884210',
  dotNumber: '3126540',
  authorityStatus: 'active',
  remitDigest: 'r1',
  bankDigest: 'b1',
  powerUnits: 2,
});

const advocate = draft('advocate_enrolled', 'adv_1', {
  advocate: 'adv_1',
  carrier: 'cxr_1',
  program: 'prg_1',
  referralCode: 'AB3K9ZQ',
  from: '2025-01-01',
});

const referral = draft('referral_opened', 'prg_1:cxr_9', {
  program: 'prg_1',
  invitee: 'cxr_9',
  recordedOn: '2025-02-01',
});

describe('an empty store', () => {
  it('has nothing in it', () => {
    const store = Store.empty();
    expect(store.sequence).toBe(0);
    expect(store.carriers.size).toBe(0);
    expect(store.tableNames()).toContain('accruals');
  });
});

describe('commit', () => {
  it('writes the journal and the tables together', () => {
    const store = Store.empty();
    unwrap(store.commit([carrier, advocate]));
    expect(store.sequence).toBe(2);
    expect(store.carriers.get('cxr_1')!.legalName).toBe('Brannan Hauling');
    expect(store.advocates.get('adv_1')!.referralCode).toBe('AB3K9ZQ');
  });

  it('leaves neither behind when a draft is bad', () => {
    const store = Store.empty();
    unwrap(store.commit([carrier]));
    const r = store.commit([advocate, draft('nonsense_happened', 'k', {})]);
    expect(isErr(r)).toBe(true);
    expect(store.sequence).toBe(1);
    expect(store.advocates.size).toBe(0);
    expect(store.carriers.size).toBe(1);
  });

  it('leaves neither behind when a payload is short', () => {
    const store = Store.empty();
    const r = store.commit([draft('advocate_enrolled', 'adv_1', { advocate: 'adv_1' })]);
    expect(isErr(r)).toBe(true);
    expect(store.sequence).toBe(0);
    expect(store.advocates.size).toBe(0);
  });
});

describe('the fold over enrolment and referrals', () => {
  it('closes an enrolment spell', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        carrier,
        advocate,
        draft('advocate_withdrawn', 'adv_1', {
          advocate: 'adv_1',
          until: '2025-06-01',
          reason: 'withdrew',
        }),
      ]),
    );
    expect(store.advocates.get('adv_1')!.enrolledUntil).toBe('2025-06-01');
  });

  it('ignores a withdrawal for somebody who was never enrolled', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        draft('advocate_withdrawn', 'adv_9', {
          advocate: 'adv_9',
          until: '2025-06-01',
          reason: 'withdrew',
        }),
      ]),
    );
    expect(store.advocates.size).toBe(0);
  });

  it('moves a referral through its states', () => {
    const store = Store.empty();
    const key = referralKeyOf('prg_1', 'cxr_9');
    unwrap(store.commit([referral]));
    expect(store.referrals.get(key)!.state).toBe('recorded');
    unwrap(
      store.commit([
        draft('referral_attributed', key, {
          program: 'prg_1',
          invitee: 'cxr_9',
          advocate: 'adv_1',
          effectiveActivation: '2025-03-01',
        }),
      ]),
    );
    expect(store.referrals.get(key)!.advocate).toBe('adv_1');
  });

  it('clears the reversal day when a referral qualifies again', () => {
    const store = Store.empty();
    const key = referralKeyOf('prg_1', 'cxr_9');
    unwrap(
      store.commit([
        referral,
        draft('referral_qualified', key, {
          program: 'prg_1',
          invitee: 'cxr_9',
          qualifiedOn: '2025-05-01',
        }),
        draft('referral_reversed', key, {
          program: 'prg_1',
          invitee: 'cxr_9',
          reversedOn: '2025-07-01',
          reason: 'retention_failed',
        }),
        draft('referral_qualified', key, {
          program: 'prg_1',
          invitee: 'cxr_9',
          qualifiedOn: '2025-08-01',
        }),
      ]),
    );
    expect(store.referrals.get(key)!.reversedOn).toBe(NO_DAY);
    expect(store.referrals.get(key)!.state).toBe('qualified');
  });

  it('indexes a referral by advocate only once it has one', () => {
    const store = Store.empty();
    const key = referralKeyOf('prg_1', 'cxr_9');
    unwrap(store.commit([referral]));
    expect(unwrap(store.referrals.by('advocate', ''))).toHaveLength(0);
    unwrap(
      store.commit([
        draft('referral_attributed', key, {
          program: 'prg_1',
          invitee: 'cxr_9',
          advocate: 'adv_1',
          effectiveActivation: '2025-03-01',
        }),
      ]),
    );
    expect(unwrap(store.referrals.by('advocate', 'adv_1'))).toHaveLength(1);
  });
});

describe('the fold over loads, claims and flags', () => {
  const delivered = draft('load_delivered', 'lod_1', {
    load: 'lod_1',
    carrier: 'cxr_9',
    proNumber: 'PL-1',
    deliveredOn: '2025-05-12',
    lineHaulMinor: 285_000,
    carrierPayMinor: 232_000,
    currency: 'USD',
    originState: 'IL',
    destinationState: 'TX',
  });

  it('amends one field of a load and leaves the rest', () => {
    const store = Store.empty();
    unwrap(store.commit([delivered]));
    unwrap(
      store.commit([
        draft('load_amended', 'lod_1', { load: 'lod_1', field: 'carrierPayMinor', value: 240_000 }),
      ]),
    );
    expect(store.loads.get('lod_1')!.carrierPayMinor).toBe(240_000);
    expect(store.loads.get('lod_1')!.lineHaulMinor).toBe(285_000);
  });

  it('amends a status', () => {
    const store = Store.empty();
    unwrap(store.commit([delivered]));
    unwrap(
      store.commit([
        draft('load_amended', 'lod_1', { load: 'lod_1', field: 'status', value: 'refused' }),
      ]),
    );
    expect(store.loads.get('lod_1')!.status).toBe('refused');
  });

  it('ignores an amendment to a load it has never seen', () => {
    const store = Store.empty();
    unwrap(store.commit([draft('load_amended', 'lod_9', { load: 'lod_9', field: 'status' })]));
    expect(store.loads.size).toBe(0);
  });

  it('refuses a second load on the same carrier and pro number', () => {
    const store = Store.empty();
    unwrap(store.commit([delivered]));
    const r = store.commit([{ ...delivered, payload: { ...delivered.payload, load: 'lod_2' } }]);
    expect(isErr(r)).toBe(true);
    expect(store.loads.size).toBe(1);
  });

  it('lets the later statement about a claim win', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        draft('claim_stated', 'clm_1', {
          claim: 'clm_1',
          load: 'lod_1',
          raisedOn: '2025-03-01',
          disposition: 'open',
          amountMinor: 150_000,
          currency: 'USD',
        }),
        draft('claim_stated', 'clm_1', {
          claim: 'clm_1',
          load: 'lod_1',
          raisedOn: '2025-03-01',
          disposition: 'charged_to_carrier',
          amountMinor: 150_000,
          currency: 'USD',
        }),
      ]),
    );
    expect(store.claims.size).toBe(1);
    expect(store.claims.get('clm_1')!.disposition).toBe('charged_to_carrier');
  });

  it('raises and clears an eligibility flag', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        draft('eligibility_flag_raised', 'adv_1', {
          advocate: 'adv_1',
          flag: 'w9_missing',
          raisedOn: '2025-03-01',
        }),
      ]),
    );
    expect(store.flags.get('adv_1:w9_missing')!.clearedOn).toBe(NO_DAY);
    unwrap(
      store.commit([
        draft('eligibility_flag_cleared', 'adv_1', {
          advocate: 'adv_1',
          flag: 'w9_missing',
          clearedOn: '2025-04-01',
        }),
      ]),
    );
    expect(store.flags.get('adv_1:w9_missing')!.clearedOn).toBe('2025-04-01');
  });

  it('moves a batch along', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        draft('batch_cut', 'bch_1', {
          batch: 'bch_1',
          periodFrom: '2025-05-01',
          periodUntil: '2025-06-01',
          cutOn: '2025-06-02',
          currency: 'USD',
        }),
        draft('batch_released', 'bch_1', { batch: 'bch_1', releasedOn: '2025-06-03' }),
        draft('batch_paid', 'bch_1', { batch: 'bch_1', paidOn: '2025-06-05' }),
      ]),
    );
    expect(store.batches.get('bch_1')!.state).toBe('paid');
  });
});

describe('rebuilding', () => {
  function filled(): Store {
    const store = Store.empty();
    unwrap(store.commit([carrier, advocate, referral]));
    return store;
  }

  it('rebuilds the same tables from the journal alone', () => {
    const store = filled();
    const again = unwrap(Store.fromLog(store.journal));
    expect(again.carriers.all()).toEqual(store.carriers.all());
    expect(again.referrals.all()).toEqual(store.referrals.all());
  });

  it('rebuilds in place', () => {
    const store = filled();
    unwrap(store.rebuild());
    expect(store.carriers.size).toBe(1);
    expect(store.advocates.size).toBe(1);
  });

  it('resumes from a snapshot', () => {
    const store = filled();
    const snapshot = store.snapshot();
    unwrap(
      store.commit([
        draft('carrier_filed', 'cxr_2', {
          carrier: 'cxr_2',
          legalName: 'Delacroix Transport',
          motorCarrierNumber: 'MC991002',
          dotNumber: '4410781',
          authorityStatus: 'active',
          remitDigest: 'r2',
          bankDigest: 'b2',
          powerUnits: 1,
        }),
      ]),
    );
    const resumed = unwrap(Store.fromSnapshot(store.journal, snapshot));
    expect(resumed.carriers.size).toBe(2);
  });

  it('refuses a snapshot from another journal', () => {
    const snapshot = filled().snapshot();
    const other = Store.empty();
    unwrap(other.commit([referral, advocate, carrier]));
    expect(isErr(Store.fromSnapshot(other.journal, snapshot))).toBe(true);
  });

  it('refuses a journal carrying a kind it does not know', () => {
    const log = JournalLog.empty();
    unwrap(log.append(draft('nonsense_happened', 'k', {})));
    expect(isErr(Store.fromLog(log))).toBe(true);
  });
});
