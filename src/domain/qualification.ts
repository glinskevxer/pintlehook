/**
 * Qualification. A referral qualifies once the invited carrier has delivered
 * the required number of loads inside the qualifying window, which runs forward
 * from effective activation.
 *
 * Two details do real work here. The qualifying load is the nth one, and its
 * delivery day is the day the referral qualifies, which is the day the accrual
 * is dated and therefore the day that decides the program year it lands in. And
 * a load with a negative margin still counts towards the number even though it
 * contributes nothing to a margin share, because the count is about the carrier
 * hauling and the margin is about what the referral was worth.
 */

import type { Day } from '../util/clock.js';
import { contains, intervalOfLength, type DayInterval } from '../util/interval.js';
import { money, sum, type Currency, type Money } from '../util/money.js';
import { sorted } from '../util/ordering.js';
import { ok, type Result } from '../util/result.js';
import { requireAllCurrency, requireWholeCount, requireWholeDays } from './rules.js';
import { grossMargin, isDelivered, loadOrder, type Load } from './load.js';

export interface QualificationInput {
  readonly loads: readonly Load[];
  readonly effectiveActivation: Day;
  readonly qualifyingLoadCount: number;
  readonly qualifyingWindowDays: number;
  readonly currency: Currency;
}

export type QualificationOutcome =
  | {
      readonly qualified: true;
      readonly qualifiedOn: Day;
      readonly qualifyingLoad: Load;
      readonly window: DayInterval;
      readonly countingLoads: readonly Load[];
      readonly deliveredMargin: Money;
      readonly shortBy: 0;
    }
  | {
      readonly qualified: false;
      readonly window: DayInterval;
      readonly countingLoads: readonly Load[];
      readonly deliveredMargin: Money;
      readonly shortBy: number;
    };

export function qualifyingWindow(effectiveActivation: Day, days: number): Result<DayInterval> {
  const checked = requireWholeDays('qualifying_window_length', 'qualifying window', days);
  return checked.ok ? ok(intervalOfLength(effectiveActivation, days)) : checked;
}

export function countsTowardsQualification(load: Load, window: DayInterval): boolean {
  return isDelivered(load) && load.deliveredOn !== undefined && contains(window, load.deliveredOn);
}

export function resolveQualification(input: QualificationInput): Result<QualificationOutcome> {
  const count = requireWholeCount(
    'qualifying_count_invalid',
    'qualifying load count',
    input.qualifyingLoadCount,
  );
  if (!count.ok) {
    return count;
  }
  const window = qualifyingWindow(input.effectiveActivation, input.qualifyingWindowDays);
  if (!window.ok) {
    return window;
  }
  const counting = sorted(
    input.loads.filter((load) => countsTowardsQualification(load, window.value)),
    loadOrder,
  );
  const currencies = requireAllCurrency(
    'qualifying_currency_mismatch',
    input.currency,
    counting,
    (load) => load.currency,
    (load) => `load ${load.proNumber}`,
  );
  if (!currencies.ok) {
    return currencies;
  }
  const deliveredMargin = sum(
    counting.map((load) => grossMargin(load)),
    input.currency,
  );
  if (counting.length < input.qualifyingLoadCount) {
    return ok({
      qualified: false,
      window: window.value,
      countingLoads: counting,
      deliveredMargin,
      shortBy: input.qualifyingLoadCount - counting.length,
    });
  }
  const qualifyingLoad = counting[input.qualifyingLoadCount - 1] as Load;
  const qualifiedOn = qualifyingLoad.deliveredOn as Day;
  return ok({
    qualified: true,
    qualifiedOn,
    qualifyingLoad,
    window: window.value,
    countingLoads: counting,
    deliveredMargin,
    shortBy: 0,
  });
}

/** The margin behind a qualified referral, which a margin share is taken from. */
export function qualifyingMargin(outcome: QualificationOutcome, currency: Currency): Money {
  return outcome.qualified ? outcome.deliveredMargin : money(currency, 0);
}

export function describeQualification(outcome: QualificationOutcome): string {
  if (outcome.qualified) {
    return `qualified on ${outcome.qualifyingLoad.proNumber} with ${outcome.countingLoads.length} loads`;
  }
  return `short by ${outcome.shortBy} of the qualifying loads`;
}
