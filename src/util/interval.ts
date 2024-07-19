/**
 * Half open day intervals. Every window in the program is half open on the
 * right so that two consecutive periods can never both own the same day, which
 * is the mistake that puts one delivered load in two settlement batches.
 */

import { addDays, compareDays, daysBetween, formatDay, isBefore, type Day } from './clock.js';

export interface DayInterval {
  /** Inclusive. */
  readonly from: Day;
  /** Exclusive. */
  readonly until: Day;
}

export function interval(from: Day, until: Day): DayInterval {
  if (!isBefore(from, until)) {
    throw new Error(`empty or inverted interval: ${formatDay(from)} to ${formatDay(until)}`);
  }
  return { from, until };
}

export function intervalOfLength(from: Day, days: number): DayInterval {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`interval length must be a positive whole number of days, got ${days}`);
  }
  return { from, until: addDays(from, days) };
}

/** The window that ends the day before an anchor and runs back the given length. */
export function windowEndingBefore(anchor: Day, days: number): DayInterval {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`window length must be a positive whole number of days, got ${days}`);
  }
  return { from: addDays(anchor, -days), until: anchor };
}

/** The window that ends on and includes an anchor day. */
export function windowEndingOn(anchor: Day, days: number): DayInterval {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`window length must be a positive whole number of days, got ${days}`);
  }
  return { from: addDays(anchor, -(days - 1)), until: addDays(anchor, 1) };
}

export function lengthInDays(value: DayInterval): number {
  return daysBetween(value.from, value.until);
}

export function contains(value: DayInterval, candidate: Day): boolean {
  return compareDays(candidate, value.from) >= 0 && isBefore(candidate, value.until);
}

export function overlaps(left: DayInterval, right: DayInterval): boolean {
  return isBefore(left.from, right.until) && isBefore(right.from, left.until);
}

export function isAdjacent(left: DayInterval, right: DayInterval): boolean {
  return compareDays(left.until, right.from) === 0 || compareDays(right.until, left.from) === 0;
}

export function intersection(left: DayInterval, right: DayInterval): DayInterval | undefined {
  const from = compareDays(left.from, right.from) >= 0 ? left.from : right.from;
  const until = isBefore(left.until, right.until) ? left.until : right.until;
  return isBefore(from, until) ? { from, until } : undefined;
}

export function union(left: DayInterval, right: DayInterval): DayInterval | undefined {
  if (!overlaps(left, right) && !isAdjacent(left, right)) {
    return undefined;
  }
  const from = isBefore(left.from, right.from) ? left.from : right.from;
  const until = compareDays(left.until, right.until) >= 0 ? left.until : right.until;
  return { from, until };
}

export function compareIntervals(left: DayInterval, right: DayInterval): number {
  const byStart = compareDays(left.from, right.from);
  return byStart !== 0 ? byStart : compareDays(left.until, right.until);
}

/** Merge a list into the smallest set of intervals covering the same days. */
export function mergeIntervals(values: readonly DayInterval[]): DayInterval[] {
  const sorted = [...values].sort(compareIntervals);
  const merged: DayInterval[] = [];
  for (const candidate of sorted) {
    const last = merged[merged.length - 1];
    if (last === undefined) {
      merged.push(candidate);
      continue;
    }
    const combined = union(last, candidate);
    if (combined === undefined) {
      merged.push(candidate);
    } else {
      merged[merged.length - 1] = combined;
    }
  }
  return merged;
}

/** Cut a covering interval into consecutive periods of a fixed day length. */
export function splitIntoPeriods(value: DayInterval, days: number): DayInterval[] {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`period length must be a positive whole number of days, got ${days}`);
  }
  const periods: DayInterval[] = [];
  let cursor = value.from;
  while (isBefore(cursor, value.until)) {
    const next = addDays(cursor, days);
    const until = isBefore(next, value.until) ? next : value.until;
    periods.push({ from: cursor, until });
    cursor = next;
  }
  return periods;
}

export function formatInterval(value: DayInterval): string {
  return `[${formatDay(value.from)}, ${formatDay(value.until)})`;
}
