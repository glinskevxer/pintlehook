/**
 * Recovery. When the clawbacks against an advocate come to more than the
 * program owes them, the difference does not vanish and it is not chased. It
 * sits as a recovery balance and comes off the next settlements.
 *
 * It comes off gradually. Taking the whole balance out of one settlement run
 * would zero a driver's cheque, so a run withholds at most a stated share of
 * what would otherwise have been paid, and the rest stays on the balance and
 * ages. The ageing is what the exception report reads, and the balance is what
 * the hold rules read, so the recovery policy reaches two layers it does not
 * mention.
 */

import { addDays, compareDays, daysBetween, type Day } from '../util/clock.js';
import {
  add,
  floorAtZero,
  minMoney,
  money,
  negate,
  subtract,
  sum,
  zero,
  type Currency,
  type Money,
} from '../util/money.js';
import { applyRate, type BasisPoints } from '../util/rate.js';
import { ok, type Result } from '../util/result.js';
import { requireCurrency, requireNotNegative } from './rules.js';

export interface RecoveryPolicy {
  /** Most of a settlement that may be withheld against a recovery balance. */
  readonly withholdingShare: BasisPoints;
  /** Days after which an unrecovered balance is reported as stale. */
  readonly staleAfterDays: number;
  readonly currency: Currency;
}

export interface RecoveryBalance {
  readonly outstanding: Money;
  readonly openedOn?: Day | undefined;
  readonly lastAppliedOn?: Day | undefined;
}

export interface RecoveryApplication {
  readonly withheld: Money;
  readonly paid: Money;
  readonly balanceAfter: RecoveryBalance;
}

export function emptyBalance(currency: Currency): RecoveryBalance {
  return { outstanding: zero(currency), openedOn: undefined, lastAppliedOn: undefined };
}

export function isClear(balance: RecoveryBalance): boolean {
  return balance.outstanding.minor <= 0;
}

/** Turn a negative advocate position into an addition to the recovery balance. */
export function openFrom(
  balance: RecoveryBalance,
  position: Money,
  on: Day,
): Result<RecoveryBalance> {
  const matched = requireCurrency(
    'recovery_currency_mismatch',
    balance.outstanding.currency,
    position,
    'the position',
  );
  if (!matched.ok) {
    return matched;
  }
  if (position.minor >= 0) {
    return ok(balance);
  }
  return ok({
    outstanding: add(balance.outstanding, negate(position)),
    openedOn: balance.openedOn ?? on,
    lastAppliedOn: balance.lastAppliedOn,
  });
}

/**
 * Apply a balance against one settlement. Returns what is withheld, what is
 * still paid, and the balance that carries forward.
 */
export function applyToSettlement(
  balance: RecoveryBalance,
  grossPayable: Money,
  policy: RecoveryPolicy,
  on: Day,
): Result<RecoveryApplication> {
  const settlementCurrency = requireCurrency(
    'recovery_currency_mismatch',
    policy.currency,
    grossPayable,
    'the settlement',
  );
  if (!settlementCurrency.ok) {
    return settlementCurrency;
  }
  const balanceCurrency = requireCurrency(
    'recovery_currency_mismatch',
    policy.currency,
    balance.outstanding,
    'the balance',
  );
  if (!balanceCurrency.ok) {
    return balanceCurrency;
  }
  const payable = requireNotNegative(
    'recovery_negative_settlement',
    'a settlement',
    grossPayable.minor,
  );
  if (!payable.ok) {
    return payable;
  }
  if (isClear(balance)) {
    return ok({ withheld: zero(policy.currency), paid: grossPayable, balanceAfter: balance });
  }
  const ceiling = applyRate(grossPayable, policy.withholdingShare, 'down');
  const withheld = minMoney(ceiling, balance.outstanding);
  const outstanding = floorAtZero(subtract(balance.outstanding, withheld));
  const cleared = outstanding.minor === 0;
  return ok({
    withheld,
    paid: subtract(grossPayable, withheld),
    balanceAfter: {
      outstanding,
      openedOn: cleared ? undefined : balance.openedOn,
      lastAppliedOn: withheld.minor > 0 ? on : balance.lastAppliedOn,
    },
  });
}

export function isStale(balance: RecoveryBalance, policy: RecoveryPolicy, asOf: Day): boolean {
  if (isClear(balance) || balance.openedOn === undefined) {
    return false;
  }
  return daysBetween(balance.openedOn, asOf) >= policy.staleAfterDays;
}

export function staleOn(balance: RecoveryBalance, policy: RecoveryPolicy): Day | undefined {
  if (isClear(balance) || balance.openedOn === undefined) {
    return undefined;
  }
  return addDays(balance.openedOn, policy.staleAfterDays);
}

export function ageInDays(balance: RecoveryBalance, asOf: Day): number {
  if (balance.openedOn === undefined) {
    return 0;
  }
  return Math.max(0, daysBetween(balance.openedOn, asOf));
}

export function totalOutstanding(balances: readonly RecoveryBalance[], currency: Currency): Money {
  return sum(
    balances.map((balance) => balance.outstanding),
    currency,
  );
}

export function describeBalance(balance: RecoveryBalance, asOf: Day): string {
  if (isClear(balance)) {
    return 'no recovery outstanding';
  }
  return `${balance.outstanding.minor} minor units outstanding for ${ageInDays(balance, asOf)} days`;
}

export function balanceOnDay(balance: RecoveryBalance, when: Day): boolean {
  return balance.openedOn !== undefined && compareDays(balance.openedOn, when) <= 0;
}

export function fromMinor(currency: Currency, minor: number, openedOn: Day): RecoveryBalance {
  return { outstanding: money(currency, minor), openedOn, lastAppliedOn: undefined };
}
