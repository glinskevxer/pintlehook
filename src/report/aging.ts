/**
 * Accrual ageing. What the program owes, bucketed by how long it has been
 * sitting unpaid, which is the number the finance desk carries to the accrual
 * review every month.
 *
 * The buckets are open on the right and the last one is unbounded, so every
 * posting lands in exactly one and nothing can be missed by a boundary. That
 * has to be tested rather than assumed, because a posting that falls between
 * two buckets does not appear anywhere and nothing shouts about it.
 */

import { daysBetween, formatDay, type Day } from '../util/clock.js';
import { money, sum, type Currency, type Money } from '../util/money.js';
import { ok, type Result } from '../util/result.js';
import type { AdvocateId } from '../domain/identity.js';
import type { Context } from '../service/context.js';
import { accrualsOfAdvocate, enrolledAdvocates } from '../storage/repositories.js';
import { requireDayText } from '../storage/rows.js';
import type { ProgramId } from '../domain/identity.js';
import { moneyColumn, numberColumn, textColumn, type Report } from './table.js';

export const BUCKET_EDGES = [30, 60, 90] as const;

export const BUCKET_NAMES = ['0 to 29', '30 to 59', '60 to 89', '90 and over'] as const;

export function bucketFor(ageDays: number): number {
  for (let at = 0; at < BUCKET_EDGES.length; at += 1) {
    if (ageDays < (BUCKET_EDGES[at] as number)) {
      return at;
    }
  }
  return BUCKET_EDGES.length;
}

export interface AgingRow {
  readonly advocate: string;
  readonly buckets: readonly Money[];
  readonly total: Money;
  readonly oldestDays: number;
}

export function agingFor(
  context: Context,
  program: ProgramId,
  asOf: Day,
  currency: Currency,
): Result<AgingRow[]> {
  const rows: AgingRow[] = [];
  for (const advocate of enrolledAdvocates(context.store, program)) {
    const minors = BUCKET_NAMES.map(() => 0);
    let oldest = 0;
    let total = 0;
    for (const posting of accrualsOfAdvocate(context.store, advocate.id as AdvocateId)) {
      const postedOn = requireDayText(posting.postedOn, 'postedOn');
      if (!postedOn.ok) {
        return postedOn;
      }
      const age = Math.max(0, daysBetween(postedOn.value, asOf));
      const at = bucketFor(age);
      minors[at] = (minors[at] as number) + posting.amountMinor;
      total += posting.amountMinor;
      oldest = Math.max(oldest, age);
    }
    if (total === 0 && oldest === 0) {
      continue;
    }
    rows.push({
      advocate: advocate.id,
      buckets: minors.map((minor) => money(currency, minor)),
      total: money(currency, total),
      oldestDays: oldest,
    });
  }
  return ok(rows);
}

export function agingReport(
  rows: readonly AgingRow[],
  asOf: Day,
  currency: Currency,
): Report<AgingRow> {
  const columns = [
    textColumn<AgingRow>('advocate', 'advocate', (row) => row.advocate),
    ...BUCKET_NAMES.map((name, at) =>
      moneyColumn<AgingRow>(`b${at}`, name, (row) => row.buckets[at] as Money),
    ),
    moneyColumn<AgingRow>('total', 'total', (row) => row.total),
    numberColumn<AgingRow>('oldest', 'oldest', (row) => row.oldestDays),
  ];
  const total = sum(
    rows.map((row) => row.total),
    currency,
  );
  return {
    title: `accrual ageing as at ${formatDay(asOf)}`,
    columns,
    rows,
    footnotes: [
      `${rows.length} advocates carrying ${total.minor} minor units`,
      'buckets are days since the posting was made, open on the right',
    ],
  };
}

export function bucketTotals(rows: readonly AgingRow[], currency: Currency): Money[] {
  return BUCKET_NAMES.map((_name, at) =>
    sum(
      rows.map((row) => row.buckets[at] as Money),
      currency,
    ),
  );
}

/** Every posting has to land in exactly one bucket, so the parts add to the whole. */
export function bucketsAddUp(row: AgingRow): boolean {
  const parts = row.buckets.reduce((running, bucket) => running + bucket.minor, 0);
  return parts === row.total.minor;
}
