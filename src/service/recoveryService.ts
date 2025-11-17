/**
 * Where an advocate's recovery balance comes from.
 *
 * The settlement service was deriving this inline from the sign of the net
 * position, which is right as far as it goes and says nothing about how long
 * the balance has been sitting. The ageing is what the exception report reads
 * and what the release ceiling is compared against, so it has to come from the
 * accruals rather than from a sign test at cut time.
 */

import { compareDays, type Day } from '../util/clock.js';
import { money, type Currency } from '../util/money.js';
import { ok, type Result } from '../util/result.js';
import type { AdvocateId } from '../domain/identity.js';
import {
  emptyBalance,
  isStale,
  type RecoveryBalance,
  type RecoveryPolicy,
} from '../domain/recovery.js';
import { accrualsOfAdvocate } from '../storage/repositories.js';
import { requireDayText } from '../storage/rows.js';
import type { Context } from './context.js';

/**
 * Walk the postings in order and track when the running position last went
 * under water. The opening day of the balance is the day it went negative and
 * stayed negative, not the day of the posting that happened to be biggest.
 */
export function balanceFor(
  context: Context,
  advocate: AdvocateId,
  currency: Currency,
  asOf: Day,
): Result<RecoveryBalance> {
  let running = 0;
  let openedOn: Day | undefined;
  for (const row of accrualsOfAdvocate(context.store, advocate)) {
    const postedOn = requireDayText(row.postedOn, 'postedOn');
    if (!postedOn.ok) {
      return postedOn;
    }
    if (compareDays(postedOn.value, asOf) > 0) {
      continue;
    }
    const before = running;
    running += row.amountMinor;
    if (before >= 0 && running < 0) {
      openedOn = postedOn.value;
    }
    if (running >= 0) {
      openedOn = undefined;
    }
  }
  if (running >= 0) {
    return ok(emptyBalance(currency));
  }
  return ok({
    outstanding: money(currency, -running),
    openedOn,
    lastAppliedOn: undefined,
  });
}

export function isOverCeiling(balance: RecoveryBalance, ceilingMinor: number): boolean {
  return balance.outstanding.minor > ceilingMinor;
}

export function staleBalances(
  context: Context,
  advocates: readonly AdvocateId[],
  currency: Currency,
  policy: RecoveryPolicy,
  asOf: Day,
): Result<AdvocateId[]> {
  const stale: AdvocateId[] = [];
  for (const advocate of advocates) {
    const balance = balanceFor(context, advocate, currency, asOf);
    if (!balance.ok) {
      return balance;
    }
    if (isStale(balance.value, policy, asOf)) {
      stale.push(advocate);
    }
  }
  return ok(stale);
}

export function describeBalanceFor(balance: RecoveryBalance): string {
  return balance.outstanding.minor === 0
    ? 'nothing outstanding'
    : `${balance.outstanding.minor} minor units outstanding`;
}
