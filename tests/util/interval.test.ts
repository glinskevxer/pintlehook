import { describe, expect, it } from 'vitest';
import { day } from '../../src/util/clock.js';
import {
  compareIntervals,
  contains,
  formatInterval,
  intersection,
  interval,
  intervalOfLength,
  isAdjacent,
  lengthInDays,
  mergeIntervals,
  overlaps,
  splitIntoPeriods,
  union,
  windowEndingBefore,
  windowEndingOn,
} from '../../src/util/interval.js';

const march = (d: number) => day(2025, 3, d);

describe('construction', () => {
  it('refuses an empty interval', () => {
    expect(() => interval(march(3), march(3))).toThrow(/empty or inverted/);
  });

  it('refuses an inverted interval', () => {
    expect(() => interval(march(5), march(3))).toThrow(/empty or inverted/);
  });

  it('builds by length', () => {
    expect(intervalOfLength(march(3), 4)).toEqual({ from: march(3), until: march(7) });
  });

  it('refuses a zero length', () => {
    expect(() => intervalOfLength(march(3), 0)).toThrow(/positive whole number/);
  });
});

describe('windows', () => {
  it('ends before the anchor and excludes it', () => {
    const w = windowEndingBefore(march(10), 3);
    expect(w).toEqual({ from: march(7), until: march(10) });
    expect(contains(w, march(10))).toBe(false);
    expect(contains(w, march(7))).toBe(true);
  });

  it('ends on the anchor and includes it', () => {
    const w = windowEndingOn(march(10), 3);
    expect(w).toEqual({ from: march(8), until: march(11) });
    expect(contains(w, march(10))).toBe(true);
    expect(contains(w, march(7))).toBe(false);
  });

  it('refuses a non positive length', () => {
    expect(() => windowEndingBefore(march(10), 0)).toThrow();
    expect(() => windowEndingOn(march(10), -2)).toThrow();
  });
});

describe('membership and length', () => {
  it('is half open on the right', () => {
    const w = interval(march(3), march(6));
    expect(contains(w, march(3))).toBe(true);
    expect(contains(w, march(5))).toBe(true);
    expect(contains(w, march(6))).toBe(false);
    expect(contains(w, march(2))).toBe(false);
  });

  it('counts length in days', () => {
    expect(lengthInDays(interval(march(3), march(6)))).toBe(3);
  });
});

describe('overlap and adjacency', () => {
  it('finds an overlap', () => {
    expect(overlaps(interval(march(1), march(5)), interval(march(4), march(9)))).toBe(true);
  });

  it('does not call touching intervals overlapping', () => {
    expect(overlaps(interval(march(1), march(5)), interval(march(5), march(9)))).toBe(false);
    expect(isAdjacent(interval(march(1), march(5)), interval(march(5), march(9)))).toBe(true);
  });

  it('sees adjacency from either side', () => {
    expect(isAdjacent(interval(march(5), march(9)), interval(march(1), march(5)))).toBe(true);
  });
});

describe('intersection', () => {
  it('returns the shared days', () => {
    const shared = intersection(interval(march(1), march(6)), interval(march(4), march(9)));
    expect(shared).toEqual({ from: march(4), until: march(6) });
  });

  it('returns nothing for disjoint intervals', () => {
    expect(
      intersection(interval(march(1), march(3)), interval(march(5), march(9))),
    ).toBeUndefined();
  });

  it('returns nothing for touching intervals', () => {
    expect(
      intersection(interval(march(1), march(5)), interval(march(5), march(9))),
    ).toBeUndefined();
  });
});

describe('union', () => {
  it('joins overlapping intervals', () => {
    expect(union(interval(march(1), march(6)), interval(march(4), march(9)))).toEqual({
      from: march(1),
      until: march(9),
    });
  });

  it('joins touching intervals', () => {
    expect(union(interval(march(1), march(5)), interval(march(5), march(9)))).toEqual({
      from: march(1),
      until: march(9),
    });
  });

  it('refuses a gap', () => {
    expect(union(interval(march(1), march(4)), interval(march(6), march(9)))).toBeUndefined();
  });

  it('keeps a contained interval inside its container', () => {
    expect(union(interval(march(1), march(9)), interval(march(3), march(5)))).toEqual({
      from: march(1),
      until: march(9),
    });
  });
});

describe('mergeIntervals', () => {
  it('collapses an unsorted overlapping list', () => {
    const merged = mergeIntervals([
      interval(march(6), march(9)),
      interval(march(1), march(4)),
      interval(march(3), march(7)),
    ]);
    expect(merged).toEqual([{ from: march(1), until: march(9) }]);
  });

  it('keeps genuine gaps apart', () => {
    const merged = mergeIntervals([interval(march(1), march(3)), interval(march(6), march(9))]);
    expect(merged).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('splitIntoPeriods', () => {
  it('cuts an exact multiple', () => {
    const periods = splitIntoPeriods(interval(march(1), march(15)), 7);
    expect(periods).toHaveLength(2);
    expect(periods[1]).toEqual({ from: march(8), until: march(15) });
  });

  it('leaves a short final period', () => {
    const periods = splitIntoPeriods(interval(march(1), march(12)), 7);
    expect(periods).toHaveLength(2);
    expect(periods[1]).toEqual({ from: march(8), until: march(12) });
  });

  it('never lets two periods claim the same day', () => {
    const periods = splitIntoPeriods(interval(march(1), march(20)), 5);
    for (let i = 1; i < periods.length; i += 1) {
      expect(overlaps(periods[i - 1]!, periods[i]!)).toBe(false);
      expect(isAdjacent(periods[i - 1]!, periods[i]!)).toBe(true);
    }
  });

  it('refuses a zero period', () => {
    expect(() => splitIntoPeriods(interval(march(1), march(5)), 0)).toThrow();
  });
});

describe('ordering and formatting', () => {
  it('orders by start then by end', () => {
    expect(
      compareIntervals(interval(march(1), march(5)), interval(march(1), march(9))),
    ).toBeLessThan(0);
    expect(
      compareIntervals(interval(march(2), march(5)), interval(march(1), march(9))),
    ).toBeGreaterThan(0);
  });

  it('shows the half open bracket', () => {
    expect(formatInterval(interval(march(1), march(5)))).toBe('[2025-03-01, 2025-03-05)');
  });
});
