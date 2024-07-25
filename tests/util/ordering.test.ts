import { describe, expect, it } from 'vitest';
import {
  ascending,
  byKey,
  byText,
  chain,
  descending,
  distinct,
  groupBy,
  indexBy,
  lastUnder,
  maxBy,
  minBy,
  partition,
  reverse,
  sorted,
  sumBy,
} from '../../src/util/ordering.js';

interface Touch {
  readonly code: string;
  readonly at: number;
  readonly channel: string;
}

const touches: Touch[] = [
  { code: 'a', at: 30, channel: 'card' },
  { code: 'b', at: 10, channel: 'link' },
  { code: 'c', at: 30, channel: 'link' },
  { code: 'd', at: 20, channel: 'card' },
];

describe('primitive comparators', () => {
  it('orders numbers both ways', () => {
    expect(sorted([3, 1, 2], ascending)).toEqual([1, 2, 3]);
    expect(sorted([3, 1, 2], descending)).toEqual([3, 2, 1]);
  });

  it('orders text without locale surprises', () => {
    expect(sorted(['b', 'A', 'a'], byText)).toEqual(['A', 'a', 'b']);
  });
});

describe('byKey and reverse', () => {
  it('projects before comparing', () => {
    const ordered = sorted(
      touches,
      byKey((t: Touch) => t.at, ascending),
    );
    expect(ordered.map((t) => t.code)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('reverses a comparator', () => {
    const ordered = sorted(touches, reverse(byKey((t: Touch) => t.at, ascending)));
    expect(ordered[0]!.at).toBe(30);
  });
});

describe('chain', () => {
  it('falls through to the next comparator on a tie', () => {
    const ordered = sorted(
      touches,
      chain(
        byKey((t: Touch) => t.at, ascending),
        byKey((t: Touch) => t.code, byText),
      ),
    );
    expect(ordered.map((t) => t.code)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('returns zero when nothing decides', () => {
    const compare = chain<Touch>(byKey((t) => t.channel, byText));
    expect(compare(touches[0]!, touches[3]!)).toBe(0);
  });

  it('handles an empty chain', () => {
    expect(chain<number>()(1, 2)).toBe(0);
  });
});

describe('sorted', () => {
  it('does not touch the input', () => {
    const input = [3, 1, 2];
    sorted(input, ascending);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('minBy and maxBy', () => {
  it('finds the extremes', () => {
    const compare = byKey((t: Touch) => t.at, ascending);
    expect(minBy(touches, compare)!.code).toBe('b');
    expect(maxBy(touches, compare)!.code).toBe('a');
  });

  it('returns nothing for an empty list', () => {
    expect(minBy([], ascending)).toBeUndefined();
    expect(maxBy([], ascending)).toBeUndefined();
  });

  it('keeps the first of equal values for maxBy', () => {
    const compare = byKey((t: Touch) => t.at, ascending);
    expect(maxBy(touches, compare)!.code).toBe('a');
  });
});

describe('lastUnder', () => {
  it('prefers the later element when two compare equal', () => {
    const compare = byKey((t: Touch) => t.at, ascending);
    expect(lastUnder(touches, compare)!.code).toBe('c');
  });

  it('agrees with maxBy when there is no tie', () => {
    const distinctTouches = touches.filter((t) => t.code !== 'c');
    const compare = byKey((t: Touch) => t.at, ascending);
    expect(lastUnder(distinctTouches, compare)!.code).toBe(maxBy(distinctTouches, compare)!.code);
  });

  it('returns nothing for an empty list', () => {
    expect(lastUnder([], ascending)).toBeUndefined();
  });
});

describe('grouping', () => {
  it('groups preserving input order inside a bucket', () => {
    const groups = groupBy(touches, (t) => t.channel);
    expect([...groups.keys()].sort()).toEqual(['card', 'link']);
    expect(groups.get('card')!.map((t) => t.code)).toEqual(['a', 'd']);
  });

  it('indexes with the last value winning', () => {
    const index = indexBy(touches, (t) => t.channel);
    expect(index.get('card')!.code).toBe('d');
    expect(index.size).toBe(2);
  });
});

describe('partition', () => {
  it('splits keeping order on both sides', () => {
    const [kept, dropped] = partition(touches, (t) => t.at >= 20);
    expect(kept.map((t) => t.code)).toEqual(['a', 'c', 'd']);
    expect(dropped.map((t) => t.code)).toEqual(['b']);
  });
});

describe('distinct', () => {
  it('keeps the first of each key', () => {
    expect(distinct(touches, (t) => t.channel).map((t) => t.code)).toEqual(['a', 'b']);
  });
});

describe('sumBy', () => {
  it('adds a projection', () => {
    expect(sumBy(touches, (t) => t.at)).toBe(90);
  });

  it('sums an empty list to zero', () => {
    expect(sumBy([], () => 1)).toBe(0);
  });
});
