import { describe, expect, it } from 'vitest';
import {
  ageInDays,
  applyToSettlement,
  balanceOnDay,
  describeBalance,
  emptyBalance,
  fromMinor,
  isClear,
  isStale,
  openFrom,
  staleOn,
  totalOutstanding,
  type RecoveryPolicy,
} from '../../src/domain/recovery.js';
import { day } from '../../src/util/clock.js';
import { money } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

const policy: RecoveryPolicy = {
  withholdingShare: 5000,
  staleAfterDays: 90,
  currency: 'USD',
};

const opened = day(2025, 3, 1);

describe('emptyBalance', () => {
  it('starts clear', () => {
    const balance = emptyBalance('USD');
    expect(isClear(balance)).toBe(true);
    expect(balance.openedOn).toBeUndefined();
  });
});

describe('openFrom', () => {
  it('adds a negative position to the balance', () => {
    const balance = unwrap(openFrom(emptyBalance('USD'), money('USD', -40_000), opened));
    expect(balance.outstanding.minor).toBe(40_000);
    expect(balance.openedOn).toEqual(opened);
  });

  it('leaves a positive position alone', () => {
    const balance = unwrap(openFrom(emptyBalance('USD'), money('USD', 40_000), opened));
    expect(isClear(balance)).toBe(true);
  });

  it('keeps the first opening day when more is added later', () => {
    const first = unwrap(openFrom(emptyBalance('USD'), money('USD', -40_000), opened));
    const second = unwrap(openFrom(first, money('USD', -10_000), day(2025, 5, 1)));
    expect(second.outstanding.minor).toBe(50_000);
    expect(second.openedOn).toEqual(opened);
  });

  it('refuses a position in another currency', () => {
    expect(isErr(openFrom(emptyBalance('USD'), money('CAD', -1), opened))).toBe(true);
  });
});

describe('applyToSettlement', () => {
  it('pays in full when there is nothing to recover', () => {
    const applied = unwrap(
      applyToSettlement(emptyBalance('USD'), money('USD', 80_000), policy, day(2025, 4, 1)),
    );
    expect(applied.withheld.minor).toBe(0);
    expect(applied.paid.minor).toBe(80_000);
  });

  it('withholds at most the stated share', () => {
    const balance = fromMinor('USD', 100_000, opened);
    const applied = unwrap(
      applyToSettlement(balance, money('USD', 80_000), policy, day(2025, 4, 1)),
    );
    expect(applied.withheld.minor).toBe(40_000);
    expect(applied.paid.minor).toBe(40_000);
    expect(applied.balanceAfter.outstanding.minor).toBe(60_000);
  });

  it('withholds only what is owed when the balance is small', () => {
    const balance = fromMinor('USD', 10_000, opened);
    const applied = unwrap(
      applyToSettlement(balance, money('USD', 80_000), policy, day(2025, 4, 1)),
    );
    expect(applied.withheld.minor).toBe(10_000);
    expect(applied.paid.minor).toBe(70_000);
    expect(isClear(applied.balanceAfter)).toBe(true);
  });

  it('clears the opening day once the balance is met', () => {
    const balance = fromMinor('USD', 10_000, opened);
    const applied = unwrap(
      applyToSettlement(balance, money('USD', 80_000), policy, day(2025, 4, 1)),
    );
    expect(applied.balanceAfter.openedOn).toBeUndefined();
  });

  it('records the day it last took something', () => {
    const balance = fromMinor('USD', 100_000, opened);
    const applied = unwrap(
      applyToSettlement(balance, money('USD', 80_000), policy, day(2025, 4, 1)),
    );
    expect(applied.balanceAfter.lastAppliedOn).toEqual(day(2025, 4, 1));
  });
});

describe('applyToSettlement edges', () => {
  it('takes nothing from a settlement of nothing and leaves the balance', () => {
    const balance = fromMinor('USD', 100_000, opened);
    const applied = unwrap(applyToSettlement(balance, money('USD', 0), policy, day(2025, 4, 1)));
    expect(applied.withheld.minor).toBe(0);
    expect(applied.balanceAfter.outstanding.minor).toBe(100_000);
    expect(applied.balanceAfter.lastAppliedOn).toBeUndefined();
  });

  it('rounds the withholding down so it never takes more than the share', () => {
    const balance = fromMinor('USD', 100_000, opened);
    const applied = unwrap(
      applyToSettlement(balance, money('USD', 1_001), policy, day(2025, 4, 1)),
    );
    expect(applied.withheld.minor).toBe(500);
  });

  it('takes several runs to clear a large balance', () => {
    let balance = fromMinor('USD', 100_000, opened);
    let runs = 0;
    while (!isClear(balance) && runs < 20) {
      balance = unwrap(
        applyToSettlement(balance, money('USD', 30_000), policy, day(2025, 4, 1)),
      ).balanceAfter;
      runs += 1;
    }
    expect(isClear(balance)).toBe(true);
    expect(runs).toBeGreaterThan(1);
  });

  it('refuses a negative settlement', () => {
    const r = applyToSettlement(emptyBalance('USD'), money('USD', -1), policy, day(2025, 4, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('recovery_negative_settlement');
    }
  });

  it('refuses a settlement in another currency', () => {
    expect(
      isErr(applyToSettlement(emptyBalance('USD'), money('CAD', 1), policy, day(2025, 4, 1))),
    ).toBe(true);
  });

  it('refuses a balance in another currency', () => {
    expect(
      isErr(applyToSettlement(emptyBalance('CAD'), money('USD', 1), policy, day(2025, 4, 1))),
    ).toBe(true);
  });
});

describe('ageing', () => {
  it('counts the age from the opening day', () => {
    expect(ageInDays(fromMinor('USD', 1, opened), day(2025, 3, 31))).toBe(30);
    expect(ageInDays(emptyBalance('USD'), day(2025, 3, 31))).toBe(0);
  });

  it('goes stale on the day the policy names', () => {
    const balance = fromMinor('USD', 1, opened);
    expect(staleOn(balance, policy)).toEqual(day(2025, 5, 30));
    expect(isStale(balance, policy, day(2025, 5, 29))).toBe(false);
    expect(isStale(balance, policy, day(2025, 5, 30))).toBe(true);
  });

  it('never calls a clear balance stale', () => {
    expect(isStale(emptyBalance('USD'), policy, day(2030, 1, 1))).toBe(false);
    expect(staleOn(emptyBalance('USD'), policy)).toBeUndefined();
  });
});

describe('totalOutstanding', () => {
  it('adds several balances', () => {
    const total = totalOutstanding(
      [fromMinor('USD', 1_000, opened), fromMinor('USD', 2_500, opened), emptyBalance('USD')],
      'USD',
    );
    expect(total.minor).toBe(3_500);
  });
});

describe('balanceOnDay', () => {
  it('is true once the balance has opened', () => {
    const balance = fromMinor('USD', 1, opened);
    expect(balanceOnDay(balance, day(2025, 3, 1))).toBe(true);
    expect(balanceOnDay(balance, day(2025, 2, 1))).toBe(false);
    expect(balanceOnDay(emptyBalance('USD'), day(2025, 3, 1))).toBe(false);
  });
});

describe('describeBalance', () => {
  it('says when there is nothing', () => {
    expect(describeBalance(emptyBalance('USD'), day(2025, 4, 1))).toBe('no recovery outstanding');
  });

  it('says how long it has been sitting', () => {
    expect(describeBalance(fromMinor('USD', 5_000, opened), day(2025, 3, 31))).toContain('30 days');
  });
});
