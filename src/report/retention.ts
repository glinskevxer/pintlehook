/**
 * Cohort retention. Invited carriers are grouped by the month they activated
 * and the report says what share of each cohort was still hauling at thirty,
 * sixty, ninety and a hundred and eighty days.
 *
 * Cohorting on activation rather than on the day the referral was recorded is
 * deliberate. The recorded day is when a card was handed over and the
 * activation day is when the carrier could first haul, so a cohort keyed on the
 * recorded day mixes carriers who took a week to onboard with ones who took two
 * months, and the curve it draws is about the compliance desk rather than about
 * retention.
 */

import { addDays, compareDays, formatDay, type Day } from '../util/clock.js';
import { byText, sorted } from '../util/ordering.js';
import { ok, type Result } from '../util/result.js';
import type { ProgramId } from '../domain/identity.js';
import type { Context } from '../service/context.js';
import { deliveredLoadsIn, referralsInState } from '../storage/repositories.js';
import { NO_DAY, requireDayText, type ReferralRow } from '../storage/rows.js';
import { interval } from '../util/interval.js';
import { numberColumn, textColumn, type Report } from './table.js';

export const CHECKPOINTS = [30, 60, 90, 180] as const;

export interface CohortRow {
  readonly cohort: string;
  readonly carriers: number;
  readonly stillHauling: readonly number[];
}

function cohortKey(activation: Day): string {
  return `${activation.year}-${String(activation.month).padStart(2, '0')}`;
}

function attributedAndLater(context: Context, program: ProgramId): ReferralRow[] {
  const rows = [
    ...referralsInState(context.store, 'attributed'),
    ...referralsInState(context.store, 'qualified'),
    ...referralsInState(context.store, 'reversed'),
  ];
  return rows.filter((row) => row.program === program && row.effectiveActivation !== NO_DAY);
}

export function cohortsFor(context: Context, program: ProgramId): Result<CohortRow[]> {
  const buckets = new Map<string, { carriers: number; hauling: number[] }>();
  for (const row of attributedAndLater(context, program)) {
    const activation = requireDayText(row.effectiveActivation, 'effectiveActivation');
    if (!activation.ok) {
      return activation;
    }
    const key = cohortKey(activation.value);
    const bucket = buckets.get(key) ?? { carriers: 0, hauling: CHECKPOINTS.map(() => 0) };
    bucket.carriers += 1;
    for (let at = 0; at < CHECKPOINTS.length; at += 1) {
      const days = CHECKPOINTS[at] as number;
      const from = addDays(activation.value, days - 30);
      const until = addDays(activation.value, days);
      if (compareDays(until, context.clock.today()) > 0) {
        continue;
      }
      const loads = deliveredLoadsIn(context.store, row.invitee, interval(from, until));
      if (!loads.ok) {
        return loads;
      }
      if (loads.value.length > 0) {
        bucket.hauling[at] = (bucket.hauling[at] as number) + 1;
      }
    }
    buckets.set(key, bucket);
  }
  const rows = [...buckets.entries()].map(([cohort, bucket]) => ({
    cohort,
    carriers: bucket.carriers,
    stillHauling: bucket.hauling,
  }));
  return ok(sorted(rows, (left, right) => byText(left.cohort, right.cohort)));
}

export function shareAt(row: CohortRow, at: number): number {
  const held = row.stillHauling[at];
  return row.carriers === 0 || held === undefined ? 0 : held / row.carriers;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function retentionReport(rows: readonly CohortRow[], asOf: Day): Report<CohortRow> {
  const columns = [
    textColumn<CohortRow>('cohort', 'cohort', (row) => row.cohort),
    numberColumn<CohortRow>('carriers', 'carriers', (row) => row.carriers),
    ...CHECKPOINTS.map((days, at) =>
      textColumn<CohortRow>(`d${days}`, `${days}d`, (row) => percent(shareAt(row, at))),
    ),
  ];
  return {
    title: `cohort retention as at ${formatDay(asOf)}`,
    columns,
    rows,
    footnotes: [
      'a cohort is the month the invited carrier activated, not the month they were referred',
      'a checkpoint counts a carrier that delivered anything in the thirty days ending there',
    ],
  };
}

export function totalCarriers(rows: readonly CohortRow[]): number {
  return rows.reduce((running, row) => running + row.carriers, 0);
}

export function weakestCohort(rows: readonly CohortRow[], at: number): CohortRow | undefined {
  let worst: CohortRow | undefined;
  for (const row of rows) {
    if (worst === undefined || shareAt(row, at) < shareAt(worst, at)) {
      worst = row;
    }
  }
  return worst;
}
