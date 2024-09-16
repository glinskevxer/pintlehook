import { describe, expect, it } from 'vitest';
import {
  describeTier,
  nextThreshold,
  orderedTiers,
  rewardFor,
  tierForCount,
  tierIndexForCount,
  validateSchedule,
  type RewardSchedule,
  type Tier,
} from '../../src/domain/schedule.js';
import { money } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

const schedule: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 },
    { name: 'silver', fromCount: 3, flatMinor: 40_000, marginShare: 100 },
    { name: 'gold', fromCount: 6, flatMinor: 60_000, marginShare: 250 },
  ],
};

describe('orderedTiers', () => {
  it('sorts by threshold whatever order they were written in', () => {
    const shuffled: RewardSchedule = { ...schedule, tiers: [...schedule.tiers].reverse() };
    expect(orderedTiers(shuffled).map((t) => t.name)).toEqual(['bronze', 'silver', 'gold']);
  });
});

describe('validateSchedule', () => {
  it('accepts a good schedule', () => {
    expect(unwrap(validateSchedule(schedule))).toEqual(schedule);
  });

  it('rejects an empty schedule', () => {
    expect(isErr(validateSchedule({ ...schedule, tiers: [] }))).toBe(true);
  });

  it('rejects a schedule whose lowest tier does not start at one', () => {
    const r = validateSchedule({
      ...schedule,
      tiers: schedule.tiers.filter((t) => t.fromCount !== 1),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('schedule_no_first_tier');
    }
  });

  it('rejects two tiers starting at the same count', () => {
    const clash: Tier = { name: 'silver plus', fromCount: 3, flatMinor: 50_000, marginShare: 0 };
    const r = validateSchedule({ ...schedule, tiers: [...schedule.tiers, clash] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('schedule_tier_repeated');
    }
  });

  it('rejects a negative payment', () => {
    const r = validateSchedule({
      ...schedule,
      tiers: [{ name: 'bronze', fromCount: 1, flatMinor: -1, marginShare: 0 }],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('schedule_tier_negative');
    }
  });

  it('rejects a ladder that goes down', () => {
    const falling: RewardSchedule = {
      ...schedule,
      tiers: [
        { name: 'bronze', fromCount: 1, flatMinor: 50_000, marginShare: 0 },
        { name: 'silver', fromCount: 3, flatMinor: 40_000, marginShare: 0 },
      ],
    };
    const r = validateSchedule(falling);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('schedule_tier_not_rising');
    }
  });

  it('rejects a threshold below one', () => {
    const r = validateSchedule({
      ...schedule,
      tiers: [{ name: 'bronze', fromCount: 0, flatMinor: 1, marginShare: 0 }],
    });
    expect(isErr(r)).toBe(true);
  });
});

describe('tierForCount', () => {
  it('reads the tier a count sits in', () => {
    expect(unwrap(tierForCount(schedule, 1)).name).toBe('bronze');
    expect(unwrap(tierForCount(schedule, 2)).name).toBe('bronze');
    expect(unwrap(tierForCount(schedule, 3)).name).toBe('silver');
    expect(unwrap(tierForCount(schedule, 5)).name).toBe('silver');
    expect(unwrap(tierForCount(schedule, 6)).name).toBe('gold');
    expect(unwrap(tierForCount(schedule, 40)).name).toBe('gold');
  });

  it('refuses a count below one', () => {
    const r = tierForCount(schedule, 0);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('schedule_count_invalid');
    }
  });

  it('refuses a fractional count', () => {
    expect(isErr(tierForCount(schedule, 2.5))).toBe(true);
  });
});

describe('tierIndexForCount', () => {
  it('gives a rising index', () => {
    expect(tierIndexForCount(schedule, 1)).toBe(0);
    expect(tierIndexForCount(schedule, 3)).toBe(1);
    expect(tierIndexForCount(schedule, 9)).toBe(2);
  });

  it('gives minus one below the ladder', () => {
    expect(tierIndexForCount(schedule, 0)).toBe(-1);
  });
});

describe('rewardFor', () => {
  it('pays the flat amount when the tier takes no margin share', () => {
    const tier = unwrap(tierForCount(schedule, 1));
    expect(unwrap(rewardFor(tier, 'USD', money('USD', 500_000))).minor).toBe(25_000);
  });

  it('adds the margin share', () => {
    const tier = unwrap(tierForCount(schedule, 6));
    const reward = unwrap(rewardFor(tier, 'USD', money('USD', 500_000)));
    expect(reward.minor).toBe(60_000 + 12_500);
  });

  it('refuses a margin in another currency', () => {
    const tier = unwrap(tierForCount(schedule, 1));
    const r = rewardFor(tier, 'USD', money('CAD', 100));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('schedule_currency_mismatch');
    }
  });

  it('pays only the flat amount on a zero margin', () => {
    const tier = unwrap(tierForCount(schedule, 6));
    expect(unwrap(rewardFor(tier, 'USD', money('USD', 0))).minor).toBe(60_000);
  });
});

describe('nextThreshold', () => {
  it('names the next rung', () => {
    expect(nextThreshold(schedule, 1)).toBe(3);
    expect(nextThreshold(schedule, 3)).toBe(6);
  });

  it('returns nothing at the top', () => {
    expect(nextThreshold(schedule, 6)).toBeUndefined();
  });
});

describe('describeTier', () => {
  it('reads back the way the statement prints it', () => {
    expect(describeTier(schedule.tiers[2]!, 'USD')).toBe('gold from 6: 600.00 USD plus 2.50%');
  });
});
