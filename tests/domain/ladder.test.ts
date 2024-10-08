import { describe, expect, it } from 'vitest';
import {
  runLadder,
  standingAt,
  totalForKey,
  totalPosted,
  type LadderEntry,
} from '../../src/domain/ladder.js';
import { rewardFor, tierForCount, type RewardSchedule } from '../../src/domain/schedule.js';
import { day } from '../../src/util/clock.js';
import { money } from '../../src/util/money.js';
import { unwrap } from '../../src/util/result.js';

const schedule: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 },
    { name: 'silver', fromCount: 3, flatMinor: 40_000, marginShare: 100 },
    { name: 'gold', fromCount: 6, flatMinor: 60_000, marginShare: 250 },
  ],
};

function entry(key: string, month: number, marginMinor = 100_000): LadderEntry {
  return { key, qualifiedOn: day(2025, month, 10), margin: money('USD', marginMinor) };
}

const five = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4), entry('e', 5)];

describe('an empty program year', () => {
  it('posts nothing', () => {
    const run = unwrap(runLadder(schedule, []));
    expect(run.postings).toEqual([]);
    expect(run.finalCount).toBe(0);
    expect(run.finalTier).toBeUndefined();
    expect(totalPosted(run, 'USD').minor).toBe(0);
  });
});

describe('one referral', () => {
  it('posts a single base amount at the lowest tier', () => {
    const run = unwrap(runLadder(schedule, [entry('a', 1)]));
    expect(run.postings).toHaveLength(1);
    expect(run.postings[0]!.kind).toBe('base');
    expect(run.postings[0]!.tierName).toBe('bronze');
    expect(run.postings[0]!.amount.minor).toBe(25_000);
    expect(run.crossings).toEqual([]);
  });
});

describe('crossing a threshold', () => {
  const run = unwrap(runLadder(schedule, [entry('a', 1), entry('b', 2), entry('c', 3)]));

  it('records the crossing', () => {
    expect(run.crossings).toEqual([3]);
  });

  it('posts a true up for each earlier referral, dated to the crossing', () => {
    const trueUps = run.postings.filter((p) => p.kind === 'true_up');
    expect(trueUps).toHaveLength(2);
    for (const posting of trueUps) {
      expect(posting.postedOn).toEqual(day(2025, 3, 10));
      expect(posting.tierName).toBe('silver');
    }
  });

  it('true ups the difference and not the whole new amount', () => {
    const silver = unwrap(tierForCount(schedule, 3));
    const target = unwrap(rewardFor(silver, 'USD', money('USD', 100_000)));
    const trueUp = run.postings.find((p) => p.kind === 'true_up' && p.key === 'a');
    expect(trueUp!.amount.minor).toBe(target.minor - 25_000);
  });

  it('leaves every referral in the year worth the same amount', () => {
    const silver = unwrap(tierForCount(schedule, 3));
    const target = unwrap(rewardFor(silver, 'USD', money('USD', 100_000)));
    for (const key of ['a', 'b', 'c']) {
      expect(totalForKey(run, key, 'USD').minor).toBe(target.minor);
    }
  });

  it('posts the crossing referral itself only once', () => {
    expect(run.postings.filter((p) => p.key === 'c')).toHaveLength(1);
  });
});

describe('a year that crosses twice', () => {
  const six = [...five, entry('f', 6)];
  const run = unwrap(runLadder(schedule, six));

  it('records both crossings', () => {
    expect(run.crossings).toEqual([3, 6]);
  });

  it('lands every referral on the final tier', () => {
    const gold = unwrap(tierForCount(schedule, 6));
    const target = unwrap(rewardFor(gold, 'USD', money('USD', 100_000)));
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(totalForKey(run, key, 'USD').minor).toBe(target.minor);
    }
    expect(run.finalTier!.name).toBe('gold');
  });

  it('adds up to the final tier amount times the count', () => {
    const gold = unwrap(tierForCount(schedule, 6));
    const each = unwrap(rewardFor(gold, 'USD', money('USD', 100_000)));
    expect(totalPosted(run, 'USD').minor).toBe(each.minor * 6);
  });
});

describe('referrals that carry different margins', () => {
  it('true ups each one against its own margin', () => {
    const entries = [entry('a', 1, 100_000), entry('b', 2, 400_000), entry('c', 3, 0)];
    const run = unwrap(runLadder(schedule, entries));
    const silver = unwrap(tierForCount(schedule, 3));
    expect(totalForKey(run, 'a', 'USD').minor).toBe(
      unwrap(rewardFor(silver, 'USD', money('USD', 100_000))).minor,
    );
    expect(totalForKey(run, 'b', 'USD').minor).toBe(
      unwrap(rewardFor(silver, 'USD', money('USD', 400_000))).minor,
    );
    expect(totalForKey(run, 'c', 'USD').minor).toBe(40_000);
  });
});

describe('ordering', () => {
  it('does not depend on the order the entries were given in', () => {
    const forwards = unwrap(runLadder(schedule, five));
    const backwards = unwrap(runLadder(schedule, [...five].reverse()));
    expect(totalPosted(backwards, 'USD').minor).toBe(totalPosted(forwards, 'USD').minor);
    expect(backwards.crossings).toEqual(forwards.crossings);
  });

  it('breaks a same day tie on the key so the run is repeatable', () => {
    const sameDay = [entry('b', 4), entry('a', 4), entry('c', 4)];
    const one = unwrap(runLadder(schedule, sameDay)).postings.map((p) => p.key);
    const two = unwrap(runLadder(schedule, [...sameDay].reverse())).postings.map((p) => p.key);
    expect(one).toEqual(two);
  });
});

describe('running the ladder again over a smaller set', () => {
  it('gives back less, which is how a reversal unwinds a tier', () => {
    const before = unwrap(runLadder(schedule, [entry('a', 1), entry('b', 2), entry('c', 3)]));
    const after = unwrap(runLadder(schedule, [entry('a', 1), entry('b', 2)]));
    expect(totalPosted(before, 'USD').minor).toBeGreaterThan(totalPosted(after, 'USD').minor);
    expect(totalForKey(after, 'a', 'USD').minor).toBe(25_000);
    expect(after.crossings).toEqual([]);
  });

  it('leaves the surviving referrals worth exactly the lower tier', () => {
    const after = unwrap(runLadder(schedule, [entry('a', 1), entry('b', 2)]));
    expect(after.finalTier!.name).toBe('bronze');
  });
});

describe('standingAt', () => {
  it('names the tier a count sits in', () => {
    expect(standingAt(schedule, 1)).toBe('bronze');
    expect(standingAt(schedule, 4)).toBe('silver');
    expect(standingAt(schedule, 9)).toBe('gold');
  });

  it('says so when there is nothing yet', () => {
    expect(standingAt(schedule, 0)).toBe('below the ladder');
  });
});
