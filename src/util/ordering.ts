/**
 * Comparators and stable ordering. Every list this program prints is ordered
 * by an explicit comparator, because a settlement register that reorders
 * between two runs is a register nobody can reconcile.
 */

export type Comparator<T> = (left: T, right: T) => number;

export function ascending(left: number, right: number): number {
  return left - right;
}

export function descending(left: number, right: number): number {
  return right - left;
}

export function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function byKey<T, K>(select: (value: T) => K, compare: Comparator<K>): Comparator<T> {
  return (left, right) => compare(select(left), select(right));
}

export function reverse<T>(compare: Comparator<T>): Comparator<T> {
  return (left, right) => compare(right, left);
}

/** Run comparators in order until one of them decides. */
export function chain<T>(...comparators: readonly Comparator<T>[]): Comparator<T> {
  return (left, right) => {
    for (const compare of comparators) {
      const verdict = compare(left, right);
      if (verdict !== 0) {
        return verdict;
      }
    }
    return 0;
  };
}

/** Sort a copy. The input is never touched, so callers can hold on to it. */
export function sorted<T>(values: readonly T[], compare: Comparator<T>): T[] {
  return [...values].sort(compare);
}

export function minBy<T>(values: readonly T[], compare: Comparator<T>): T | undefined {
  let best: T | undefined;
  for (const value of values) {
    if (best === undefined || compare(value, best) < 0) {
      best = value;
    }
  }
  return best;
}

export function maxBy<T>(values: readonly T[], compare: Comparator<T>): T | undefined {
  let best: T | undefined;
  for (const value of values) {
    if (best === undefined || compare(value, best) > 0) {
      best = value;
    }
  }
  return best;
}

/**
 * The last value under an ordering, preferring the later element of the input
 * when two compare equal. Attribution needs exactly this: the latest touch, and
 * where two touches carry the same instant the one the feed listed later.
 */
export function lastUnder<T>(values: readonly T[], compare: Comparator<T>): T | undefined {
  let best: T | undefined;
  for (const value of values) {
    if (best === undefined || compare(value, best) >= 0) {
      best = value;
    }
  }
  return best;
}

export function groupBy<T, K extends string>(
  values: readonly T[],
  select: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = select(value);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [value]);
    } else {
      bucket.push(value);
    }
  }
  return groups;
}

export function indexBy<T, K extends string>(
  values: readonly T[],
  select: (value: T) => K,
): Map<K, T> {
  const index = new Map<K, T>();
  for (const value of values) {
    index.set(select(value), value);
  }
  return index;
}

export function partition<T>(values: readonly T[], keep: (value: T) => boolean): [T[], T[]] {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const value of values) {
    (keep(value) ? kept : dropped).push(value);
  }
  return [kept, dropped];
}

export function distinct<T, K>(values: readonly T[], select: (value: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const value of values) {
    const key = select(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

export function sumBy<T>(values: readonly T[], select: (value: T) => number): number {
  let total = 0;
  for (const value of values) {
    total += select(value);
  }
  return total;
}
