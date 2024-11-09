/**
 * The tier ladder. An advocate climbs it on qualified referrals inside one
 * program year, and the rate the ladder gives is applied to every referral in
 * that program year, not only the ones after the crossing.
 *
 * That retroactivity is the whole point of the scheme, and it is also why the
 * ladder has to be evaluated against a count rather than incrementally: the
 * answer for a referral is a function of the year's final count, so a reversal
 * that lowers the count has to be able to run the same function again and get
 * the lower rate back.
 */

import { formatMoney, money, type Currency, type Money } from '../util/money.js';
import { applyRate, formatBasisPoints, type BasisPoints } from '../util/rate.js';
import { ascending, byKey, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import { requireCurrency } from './rules.js';

export interface Tier {
  readonly name: string;
  /** Qualified referrals in the program year at which this tier starts. */
  readonly fromCount: number;
  /** Flat amount per qualified referral, in minor units. */
  readonly flatMinor: number;
  /** Extra share of the invitee's delivered gross margin, in basis points. */
  readonly marginShare: BasisPoints;
}

export interface RewardSchedule {
  readonly currency: Currency;
  readonly tiers: readonly Tier[];
}

export function orderedTiers(schedule: RewardSchedule): Tier[] {
  return sorted(
    schedule.tiers,
    byKey((t: Tier) => t.fromCount, ascending),
  );
}

export function validateSchedule(schedule: RewardSchedule): Result<RewardSchedule> {
  if (schedule.tiers.length === 0) {
    return fail('schedule_empty', 'a reward schedule needs at least one tier');
  }
  const ordered = orderedTiers(schedule);
  const first = ordered[0] as Tier;
  if (first.fromCount !== 1) {
    return fail('schedule_no_first_tier', 'the lowest tier has to start at the first referral');
  }
  const seen = new Set<number>();
  let previousFlat = -1;
  for (const tier of ordered) {
    if (!Number.isInteger(tier.fromCount) || tier.fromCount < 1) {
      return fail('schedule_tier_threshold', `tier "${tier.name}" has a threshold below one`);
    }
    if (seen.has(tier.fromCount)) {
      return fail('schedule_tier_repeated', `two tiers start at ${tier.fromCount} referrals`);
    }
    seen.add(tier.fromCount);
    if (tier.flatMinor < 0 || tier.marginShare < 0) {
      return fail('schedule_tier_negative', `tier "${tier.name}" pays a negative amount`);
    }
    if (tier.flatMinor < previousFlat) {
      return fail(
        'schedule_tier_not_rising',
        `tier "${tier.name}" pays less than the tier below it`,
      );
    }
    previousFlat = tier.flatMinor;
  }
  return ok(schedule);
}

/** The tier a given qualified referral count sits in. Count is one based. */
export function tierForCount(schedule: RewardSchedule, count: number): Result<Tier> {
  if (!Number.isInteger(count) || count < 1) {
    return fail('schedule_count_invalid', `a qualified referral count starts at one, got ${count}`);
  }
  const ordered = orderedTiers(schedule);
  let found: Tier | undefined;
  for (const tier of ordered) {
    if (count >= tier.fromCount) {
      found = tier;
    }
  }
  return found === undefined
    ? fail('schedule_no_tier', `no tier covers a count of ${count}`)
    : ok(found);
}

export function tierIndexForCount(schedule: RewardSchedule, count: number): number {
  const ordered = orderedTiers(schedule);
  let index = -1;
  for (let i = 0; i < ordered.length; i += 1) {
    if (count >= (ordered[i] as Tier).fromCount) {
      index = i;
    }
  }
  return index;
}

/** What one qualified referral is worth at a tier, given the margin it carried. */
export function rewardFor(tier: Tier, currency: Currency, deliveredMargin: Money): Result<Money> {
  const matched = requireCurrency(
    'schedule_currency_mismatch',
    currency,
    deliveredMargin,
    'the delivered margin',
  );
  if (!matched.ok) {
    return matched;
  }
  const share = applyRate(deliveredMargin, tier.marginShare);
  return ok(money(currency, tier.flatMinor + share.minor));
}

/** The next threshold above a count, for a statement that says how close it is. */
export function nextThreshold(schedule: RewardSchedule, count: number): number | undefined {
  return orderedTiers(schedule).find((tier) => tier.fromCount > count)?.fromCount;
}

export function describeTier(tier: Tier, currency: Currency): string {
  const flat = formatMoney(money(currency, tier.flatMinor));
  return `${tier.name} from ${tier.fromCount}: ${flat} plus ${formatBasisPoints(tier.marginShare)}`;
}
