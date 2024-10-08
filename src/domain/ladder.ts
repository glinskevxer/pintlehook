/**
 * Running the ladder over one advocate's program year.
 *
 * A qualified referral posts a base amount at the tier the advocate was in when
 * it qualified. When a later referral crosses a threshold, every referral
 * already posted in that program year is re rated at the new tier and the
 * difference posts as a true up, dated to the crossing.
 *
 * The function is a pure function of the set of entries. That is the whole
 * design: a reversal removes an entry and the ladder is run again, and because
 * the same function decides the answer, the lower tier comes back by itself
 * rather than by some separate unwinding rule that could disagree with it.
 */

import { compareDays, type Day } from '../util/clock.js';
import { subtract, sum, zero, type Money } from '../util/money.js';
import { byKey, byText, chain, sorted } from '../util/ordering.js';
import { ok, type Result } from '../util/result.js';
import {
  orderedTiers,
  rewardFor,
  tierForCount,
  tierIndexForCount,
  type RewardSchedule,
  type Tier,
} from './schedule.js';

export interface LadderEntry {
  /** Whatever the caller uses to name a referral. Only used for ordering. */
  readonly key: string;
  readonly qualifiedOn: Day;
  readonly margin: Money;
}

export type PostingKind = 'base' | 'true_up';

export interface LadderPosting {
  readonly key: string;
  readonly kind: PostingKind;
  readonly postedOn: Day;
  readonly countAtPosting: number;
  readonly tierName: string;
  readonly amount: Money;
}

export interface LadderRun {
  readonly postings: readonly LadderPosting[];
  readonly finalCount: number;
  readonly finalTier?: Tier | undefined;
  readonly crossings: readonly number[];
}

export const ladderOrder = chain(
  byKey((e: LadderEntry) => e.qualifiedOn, compareDays),
  byKey((e: LadderEntry) => e.key, byText),
);

export function runLadder(
  schedule: RewardSchedule,
  entries: readonly LadderEntry[],
): Result<LadderRun> {
  const ordered = sorted(entries, ladderOrder);
  const postings: LadderPosting[] = [];
  const crossings: number[] = [];
  const postedSoFar = new Map<string, Money>();

  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i] as LadderEntry;
    const count = i + 1;
    const tier = tierForCount(schedule, count);
    if (!tier.ok) {
      return tier;
    }
    const crossed =
      count > 1 && tierIndexForCount(schedule, count) > tierIndexForCount(schedule, count - 1);
    if (crossed) {
      crossings.push(count);
      for (let j = 0; j < i; j += 1) {
        const earlier = ordered[j] as LadderEntry;
        const target = rewardFor(tier.value, schedule.currency, earlier.margin);
        if (!target.ok) {
          return target;
        }
        const already = postedSoFar.get(earlier.key) ?? zero(schedule.currency);
        const difference = subtract(target.value, already);
        if (difference.minor !== 0) {
          postings.push({
            key: earlier.key,
            kind: 'true_up',
            postedOn: entry.qualifiedOn,
            countAtPosting: count,
            tierName: tier.value.name,
            amount: difference,
          });
          postedSoFar.set(earlier.key, target.value);
        }
      }
    }
    const base = rewardFor(tier.value, schedule.currency, entry.margin);
    if (!base.ok) {
      return base;
    }
    postings.push({
      key: entry.key,
      kind: 'base',
      postedOn: entry.qualifiedOn,
      countAtPosting: count,
      tierName: tier.value.name,
      amount: base.value,
    });
    postedSoFar.set(entry.key, base.value);
  }

  const finalTier = ordered.length === 0 ? undefined : tierForCount(schedule, ordered.length);
  return ok({
    postings,
    finalCount: ordered.length,
    finalTier: finalTier === undefined || !finalTier.ok ? undefined : finalTier.value,
    crossings,
  });
}

export function totalPosted(run: LadderRun, currency: RewardSchedule['currency']): Money {
  return sum(
    run.postings.map((posting) => posting.amount),
    currency,
  );
}

export function totalForKey(
  run: LadderRun,
  key: string,
  currency: RewardSchedule['currency'],
): Money {
  return sum(
    run.postings.filter((posting) => posting.key === key).map((posting) => posting.amount),
    currency,
  );
}

/** Where the ladder would put an advocate who has qualified this many referrals. */
export function standingAt(schedule: RewardSchedule, count: number): string {
  if (count < 1) {
    return 'below the ladder';
  }
  const tier = tierForCount(schedule, count);
  return tier.ok ? tier.value.name : (orderedTiers(schedule)[0]?.name ?? 'unknown');
}
