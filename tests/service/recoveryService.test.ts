import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { RecoveryPolicy } from '../../src/domain/recovery.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  balanceFor,
  describeBalanceFor,
  isOverCeiling,
  staleBalances,
} from '../../src/service/recoveryService.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 11, 1);

const policy: RecoveryPolicy = { withholdingShare: 5000, staleAfterDays: 90, currency: 'USD' };

function accrual(seq: number, postedOn: string, amountMinor: number): JournalDraft {
  return {
    at: AT,
    kind: 'accrual_posted',
    key: `acr_${seq}`,
    payload: {
      accrual: `acr_${seq}`,
      advocate: advocateId(1),
      program: programId(1),
      referralKey: `prg_00000001:${carrierId(9)}`,
      kind: amountMinor >= 0 ? 'base' : 'true_down',
      postedOn,
      programYearFrom: '2025-01-01',
      amountMinor,
      currency: 'USD',
      reverses: '',
      note: 'posting',
    },
  };
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'settlement'));
});

describe('an advocate in credit', () => {
  it('has nothing outstanding', () => {
    unwrap(store.commit([accrual(1, '2025-03-01', 25_000)]));
    const balance = unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1)));
    expect(balance.outstanding.minor).toBe(0);
    expect(balance.openedOn).toBeUndefined();
    expect(describeBalanceFor(balance)).toBe('nothing outstanding');
  });

  it('has nothing outstanding with no postings at all', () => {
    expect(
      unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1))).outstanding.minor,
    ).toBe(0);
  });
});

describe('an advocate under water', () => {
  beforeEach(() => {
    unwrap(store.commit([accrual(1, '2025-03-01', 25_000), accrual(2, '2025-05-01', -40_000)]));
  });

  it('carries what is owed', () => {
    const balance = unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1)));
    expect(balance.outstanding.minor).toBe(15_000);
    expect(describeBalanceFor(balance)).toContain('15000');
  });

  it('opens on the day the running position went under', () => {
    const balance = unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1)));
    expect(balance.openedOn).toEqual(day(2025, 5, 1));
  });

  it('is nothing before the posting that took it under', () => {
    const balance = unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 4, 1)));
    expect(balance.outstanding.minor).toBe(0);
  });

  it('closes again once a later posting brings it back', () => {
    unwrap(store.commit([accrual(3, '2025-07-01', 20_000)]));
    const balance = unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1)));
    expect(balance.outstanding.minor).toBe(0);
    expect(balance.openedOn).toBeUndefined();
  });

  it('reopens on the later day when it goes under twice', () => {
    unwrap(store.commit([accrual(3, '2025-07-01', 20_000), accrual(4, '2025-09-01', -30_000)]));
    const balance = unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1)));
    expect(balance.openedOn).toEqual(day(2025, 9, 1));
    expect(balance.outstanding.minor).toBe(25_000);
  });

  it('fails on a posting whose day cannot be read', () => {
    unwrap(store.commit([accrual(3, 'soon', 1_000)]));
    expect(isErr(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1)))).toBe(true);
  });
});

describe('isOverCeiling', () => {
  it('compares against the ceiling the rules set', () => {
    unwrap(store.commit([accrual(1, '2025-05-01', -40_000)]));
    const balance = unwrap(balanceFor(context, advocateId(1), 'USD', day(2025, 12, 1)));
    expect(isOverCeiling(balance, 40_000)).toBe(false);
    expect(isOverCeiling(balance, 39_999)).toBe(true);
  });
});

describe('staleBalances', () => {
  it('names the advocates whose balance has been sitting', () => {
    unwrap(store.commit([accrual(1, '2025-05-01', -40_000)]));
    const stale = unwrap(staleBalances(context, [advocateId(1)], 'USD', policy, day(2025, 12, 1)));
    expect(stale).toEqual([advocateId(1)]);
  });

  it('leaves out a balance that opened recently', () => {
    unwrap(store.commit([accrual(1, '2025-11-01', -40_000)]));
    expect(
      unwrap(staleBalances(context, [advocateId(1)], 'USD', policy, day(2025, 12, 1))),
    ).toEqual([]);
  });

  it('leaves out an advocate who is in credit', () => {
    unwrap(store.commit([accrual(1, '2025-03-01', 25_000)]));
    expect(
      unwrap(staleBalances(context, [advocateId(1)], 'USD', policy, day(2025, 12, 1))),
    ).toEqual([]);
  });

  it('passes a failure through', () => {
    unwrap(store.commit([accrual(1, 'soon', -1_000)]));
    expect(isErr(staleBalances(context, [advocateId(1)], 'USD', policy, day(2025, 12, 1)))).toBe(
      true,
    );
  });
});
