/**
 * Dedupe. Two things arrive twice: whole deliveries, when a partner reruns an
 * export, and single events, when the same touch is written by two sources.
 *
 * Exact duplicates go on the natural key. Near duplicates need a tolerance,
 * because the fuel desk and the recruiting log will stamp the same handshake
 * seconds apart. The tolerance is applied on the normalised instant, so a
 * terminal running four minutes fast does not hide a duplicate that a corrected
 * clock would have caught.
 */

import type { Instant } from '../util/clock.js';
import { ascending, byKey, chain, byText, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';

export interface DedupeCandidate {
  readonly naturalKey: string;
  /** Events sharing a collapse key are the same happening if close in time. */
  readonly collapseKey: string;
  readonly at: Instant;
  readonly sourceReference: string;
  /** Higher wins when two near duplicates are collapsed. */
  readonly strength: number;
}

export interface DuplicatePair<T> {
  readonly kept: T;
  readonly dropped: T;
  readonly reason: 'exact' | 'near';
}

export interface DedupeResult<T> {
  readonly kept: readonly T[];
  readonly duplicates: readonly DuplicatePair<T>[];
}

export const candidateOrder = chain(
  byKey((c: DedupeCandidate) => c.collapseKey, byText),
  byKey((c: DedupeCandidate) => c.at, ascending),
  byKey((c: DedupeCandidate) => -c.strength, ascending),
  byKey((c: DedupeCandidate) => c.sourceReference, byText),
);

export function dedupe<T>(
  items: readonly T[],
  read: (item: T) => DedupeCandidate,
  toleranceMillis: number,
): Result<DedupeResult<T>> {
  if (!Number.isInteger(toleranceMillis) || toleranceMillis < 0) {
    return fail(
      'dedupe_tolerance_invalid',
      'the near duplicate tolerance must be a whole number of milliseconds',
    );
  }
  const ordered = sorted(items, (left, right) => candidateOrder(read(left), read(right)));
  const kept: T[] = [];
  const duplicates: DuplicatePair<T>[] = [];
  const seenExact = new Map<string, T>();
  const lastByCollapse = new Map<string, T>();

  for (const item of ordered) {
    const candidate = read(item);
    const exact = seenExact.get(candidate.naturalKey);
    if (exact !== undefined) {
      duplicates.push({ kept: exact, dropped: item, reason: 'exact' });
      continue;
    }
    const previous = lastByCollapse.get(candidate.collapseKey);
    if (previous !== undefined) {
      const gap = Math.abs(candidate.at - read(previous).at);
      if (gap <= toleranceMillis) {
        const winner = read(previous).strength >= candidate.strength ? previous : item;
        const loser = winner === previous ? item : previous;
        duplicates.push({ kept: winner, dropped: loser, reason: 'near' });
        if (winner !== previous) {
          const at = kept.indexOf(previous);
          if (at >= 0) {
            kept[at] = item;
          }
          lastByCollapse.set(candidate.collapseKey, item);
          seenExact.set(candidate.naturalKey, item);
        }
        continue;
      }
    }
    kept.push(item);
    seenExact.set(candidate.naturalKey, item);
    lastByCollapse.set(candidate.collapseKey, item);
  }
  return ok({ kept, duplicates });
}

export function duplicateRate(result: DedupeResult<unknown>): number {
  const total = result.kept.length + result.duplicates.length;
  return total === 0 ? 0 : result.duplicates.length / total;
}

export function countByReason(result: DedupeResult<unknown>): Record<'exact' | 'near', number> {
  let exact = 0;
  let near = 0;
  for (const pair of result.duplicates) {
    if (pair.reason === 'exact') {
      exact += 1;
    } else {
      near += 1;
    }
  }
  return { exact, near };
}
