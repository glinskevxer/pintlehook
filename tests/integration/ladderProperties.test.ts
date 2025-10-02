/**
 * Properties of the ladder, checked over many generated program years rather
 * than over a handful of chosen ones.
 *
 * The generator is a seeded arithmetic sequence rather than a random source, so
 * a failure names a case that can be reproduced. A property suite that draws
 * fresh numbers on every run reports a failure nobody can get back.
 */

import { describe, expect, it } from 'vitest';
import { runLadder, totalForKey, totalPosted, type LadderEntry } from '../../src/domain/ladder.js';
import { rewardFor, tierForCount, type RewardSchedule } from '../../src/domain/schedule.js';
import { day } from '../../src/util/clock.js';
import { money } from '../../src/util/money.js';
import { unwrap } from '../../src/util/result.js';

const SCHEDULE: RewardSchedule = {
  currency: 'USD',
  tiers: [
    { name: 'bronze', fromCount: 1, flatMinor: 25_000, marginShare: 0 },
    { name: 'silver', fromCount: 3, flatMinor: 40_000, marginShare: 100 },
    { name: 'gold', fromCount: 6, flatMinor: 60_000, marginShare: 250 },
    { name: 'platinum', fromCount: 12, flatMinor: 90_000, marginShare: 400 },
  ],
};

/** A seeded sequence, so a failing case is a case somebody can rerun. */
function draw(seed: number, at: number, span: number): number {
  return (seed * 7919 + at * 104_729) % span;
}

function yearOf(seed: number, count: number): LadderEntry[] {
  const entries: LadderEntry[] = [];
  for (let at = 0; at < count; at += 1) {
    const month = 1 + (draw(seed, at, 12) % 12);
    const dayOfMonth = 1 + (draw(seed + 1, at, 28) % 28);
    entries.push({
      key: `ref_${String(at).padStart(3, '0')}`,
      qualifiedOn: day(2025, month, dayOfMonth),
      margin: money('USD', draw(seed + 2, at, 900_000)),
    });
  }
  return entries;
}

const CASES = Array.from({ length: 40 }, (_value, at) => ({
  seed: at * 13 + 1,
  count: 1 + (at % 15),
}));

describe('every referral in a program year ends up on the final tier', () => {
  it.each(CASES)('seed $seed with $count referrals', ({ seed, count }) => {
    const entries = yearOf(seed, count);
    const run = unwrap(runLadder(SCHEDULE, entries));
    const finalTier = unwrap(tierForCount(SCHEDULE, count));
    for (const entry of entries) {
      const wanted = unwrap(rewardFor(finalTier, 'USD', entry.margin));
      expect(totalForKey(run, entry.key, 'USD').minor).toBe(wanted.minor);
    }
  });
});

describe('the total is the final tier amount over every referral', () => {
  it.each(CASES)('seed $seed with $count referrals', ({ seed, count }) => {
    const entries = yearOf(seed, count);
    const run = unwrap(runLadder(SCHEDULE, entries));
    const finalTier = unwrap(tierForCount(SCHEDULE, count));
    let wanted = 0;
    for (const entry of entries) {
      wanted += unwrap(rewardFor(finalTier, 'USD', entry.margin)).minor;
    }
    expect(totalPosted(run, 'USD').minor).toBe(wanted);
  });
});

describe('the run does not depend on the order the entries arrived in', () => {
  it.each(CASES)('seed $seed with $count referrals', ({ seed, count }) => {
    const entries = yearOf(seed, count);
    const forwards = unwrap(runLadder(SCHEDULE, entries));
    const backwards = unwrap(runLadder(SCHEDULE, [...entries].reverse()));
    expect(totalPosted(backwards, 'USD').minor).toBe(totalPosted(forwards, 'USD').minor);
    expect(backwards.crossings).toEqual(forwards.crossings);
  });
});

describe('taking a referral out never pays more', () => {
  it.each(CASES.filter((entry) => entry.count > 1))(
    'seed $seed with $count referrals',
    ({ seed, count }) => {
      const entries = yearOf(seed, count);
      const whole = unwrap(runLadder(SCHEDULE, entries));
      const fewer = unwrap(runLadder(SCHEDULE, entries.slice(0, -1)));
      expect(totalPosted(fewer, 'USD').minor).toBeLessThanOrEqual(totalPosted(whole, 'USD').minor);
    },
  );
});

describe('adding a referral never pays less to the ones already there', () => {
  it.each(CASES.filter((entry) => entry.count > 1))(
    'seed $seed with $count referrals',
    ({ seed, count }) => {
      const entries = yearOf(seed, count);
      const before = unwrap(runLadder(SCHEDULE, entries.slice(0, -1)));
      const after = unwrap(runLadder(SCHEDULE, entries));
      for (const entry of entries.slice(0, -1)) {
        expect(totalForKey(after, entry.key, 'USD').minor).toBeGreaterThanOrEqual(
          totalForKey(before, entry.key, 'USD').minor,
        );
      }
    },
  );
});

describe('a true up is never a payment on its own', () => {
  it.each(CASES)('seed $seed with $count referrals', ({ seed, count }) => {
    const run = unwrap(runLadder(SCHEDULE, yearOf(seed, count)));
    for (const posting of run.postings) {
      if (posting.kind === 'true_up') {
        const base = run.postings.find(
          (candidate) => candidate.key === posting.key && candidate.kind === 'base',
        );
        expect(base).toBeDefined();
      }
    }
  });
});

describe('every crossing is a real threshold', () => {
  it.each(CASES)('seed $seed with $count referrals', ({ seed, count }) => {
    const run = unwrap(runLadder(SCHEDULE, yearOf(seed, count)));
    const thresholds = SCHEDULE.tiers.map((tier) => tier.fromCount);
    for (const crossing of run.crossings) {
      expect(thresholds).toContain(crossing);
    }
  });
});
