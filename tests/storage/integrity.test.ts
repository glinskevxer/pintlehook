import { describe, expect, it } from 'vitest';
import { describeReport, runIntegrity } from '../../src/storage/integrity.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { unwrap } from '../../src/util/result.js';

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

const attributed = draft('referral_attributed', 'prg_1:cxr_9', {
  program: 'prg_1',
  invitee: 'cxr_9',
  advocate: 'adv_1',
  effectiveActivation: '2025-03-01',
});

function accrual(id: string, overrides: Record<string, unknown> = {}): JournalDraft {
  return draft('accrual_posted', id, {
    accrual: id,
    advocate: 'adv_1',
    program: 'prg_1',
    referralKey: 'prg_1:cxr_9',
    kind: 'base',
    postedOn: '2025-05-01',
    programYearFrom: '2025-01-01',
    amountMinor: 25_000,
    currency: 'USD',
    reverses: '',
    note: 'bounty',
    ...overrides,
  });
}

function clean(): Store {
  const store = Store.empty();
  unwrap(store.commit([carrier, advocate, referral, attributed, accrual('acr_1')]));
  return store;
}

describe('a clean store', () => {
  it('finds nothing', () => {
    const report = runIntegrity(clean());
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checksRun).toBeGreaterThan(8);
  });

  it('says so', () => {
    expect(describeReport(runIntegrity(clean()))).toContain('nothing found');
  });

  it('finds nothing in an empty store', () => {
    expect(runIntegrity(Store.empty()).clean).toBe(true);
  });
});

describe('dangling references', () => {
  it('catches an advocate on a carrier nobody filed', () => {
    const store = Store.empty();
    unwrap(store.commit([advocate]));
    const report = runIntegrity(store);
    expect(report.findings.some((f) => f.check === 'advocate_carrier_exists')).toBe(true);
  });

  it('catches a referral on an advocate nobody enrolled', () => {
    const store = Store.empty();
    unwrap(store.commit([referral, attributed]));
    expect(runIntegrity(store).findings.some((f) => f.check === 'referral_advocate_exists')).toBe(
      true,
    );
  });

  it('catches an accrual on a referral nobody opened', () => {
    const store = Store.empty();
    unwrap(store.commit([carrier, advocate, accrual('acr_1')]));
    expect(runIntegrity(store).findings.some((f) => f.check === 'accrual_referral_exists')).toBe(
      true,
    );
  });

  it('catches an accrual on an advocate nobody enrolled', () => {
    const store = Store.empty();
    unwrap(store.commit([referral, accrual('acr_1')]));
    expect(runIntegrity(store).findings.some((f) => f.check === 'accrual_advocate_exists')).toBe(
      true,
    );
  });

  it('catches a reversal pointing at nothing', () => {
    const store = clean();
    unwrap(
      store.commit([
        accrual('acr_2', { kind: 'reversal', reverses: 'acr_9', amountMinor: -25_000 }),
      ]),
    );
    expect(runIntegrity(store).findings.some((f) => f.check === 'reversal_points_somewhere')).toBe(
      true,
    );
  });

  it('accepts a reversal pointing at a posting that is here', () => {
    const store = clean();
    unwrap(
      store.commit([
        accrual('acr_2', { kind: 'reversal', reverses: 'acr_1', amountMinor: -25_000 }),
      ]),
    );
    expect(runIntegrity(store).clean).toBe(true);
  });

  it('catches a claim on a load nobody delivered', () => {
    const store = clean();
    unwrap(
      store.commit([
        draft('claim_stated', 'clm_1', {
          claim: 'clm_1',
          load: 'lod_9',
          raisedOn: '2025-04-01',
          disposition: 'open',
          amountMinor: 1,
          currency: 'USD',
        }),
      ]),
    );
    expect(runIntegrity(store).findings.some((f) => f.check === 'claim_load_exists')).toBe(true);
  });

  it('catches an open flag on an advocate nobody enrolled', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        draft('eligibility_flag_raised', 'adv_9', {
          advocate: 'adv_9',
          flag: 'w9_missing',
          raisedOn: '2025-03-01',
        }),
      ]),
    );
    expect(runIntegrity(store).findings.some((f) => f.check === 'flag_advocate_exists')).toBe(true);
  });
});

describe('states that contradict themselves', () => {
  it('catches a qualified referral with no advocate', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        referral,
        draft('referral_qualified', 'prg_1:cxr_9', {
          program: 'prg_1',
          invitee: 'cxr_9',
          qualifiedOn: '2025-05-01',
        }),
      ]),
    );
    expect(runIntegrity(store).findings.some((f) => f.check === 'qualified_has_advocate')).toBe(
      true,
    );
  });

  it('catches a qualified referral with no date', () => {
    const store = Store.empty();
    unwrap(
      store.commit([
        carrier,
        advocate,
        referral,
        attributed,
        draft('referral_qualified', 'prg_1:cxr_9', {
          program: 'prg_1',
          invitee: 'cxr_9',
          qualifiedOn: '',
        }),
      ]),
    );
    expect(runIntegrity(store).findings.some((f) => f.check === 'qualified_has_date')).toBe(true);
  });
});

describe('currencies and dates', () => {
  it('catches two currencies in the accrual table', () => {
    const store = clean();
    unwrap(store.commit([accrual('acr_2', { currency: 'CAD' })]));
    const report = runIntegrity(store);
    const found = report.findings.find((f) => f.check === 'one_currency_per_program');
    expect(found).toBeDefined();
    expect(found!.detail).toContain('CAD');
  });

  it('catches a posting day nothing can read', () => {
    const store = clean();
    unwrap(store.commit([accrual('acr_2', { postedOn: 'soon' })]));
    expect(runIntegrity(store).findings.some((f) => f.check === 'accrual_day_readable')).toBe(true);
  });
});

describe('ordering', () => {
  it('sorts findings by check then subject', () => {
    const store = Store.empty();
    unwrap(store.commit([advocate, referral, attributed]));
    const checks = runIntegrity(store).findings.map((f) => f.check);
    expect([...checks].sort()).toEqual(checks);
  });

  it('says how many findings there were', () => {
    const store = Store.empty();
    unwrap(store.commit([advocate]));
    expect(describeReport(runIntegrity(store))).toContain('1 findings');
  });
});
