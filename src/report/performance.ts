/**
 * Program performance. What the program cost, what it brought in, and the two
 * numbers everybody actually argues about: the share of referrals that ever
 * qualify, and the margin behind each one.
 *
 * The cost side is the accrual table and the benefit side is the delivered
 * margin of the invited carriers. Both are read from what happened rather than
 * from a forecast, so the report cannot flatter the program.
 */

import { money, subtract, sum, type Currency, type Money } from '../util/money.js';
import { byText, sorted } from '../util/ordering.js';
import { ok, type Result } from '../util/result.js';
import type { CarrierId, ProgramId } from '../domain/identity.js';
import { grossMargin } from '../domain/load.js';
import { deliveredLoadsOf } from '../service/qualificationService.js';
import type { Context } from '../service/context.js';
import { accrualsOfAdvocate, enrolledAdvocates } from '../storage/repositories.js';
import { moneyColumn, numberColumn, textColumn, type Report } from './table.js';

export interface AdvocatePerformance {
  readonly advocate: string;
  readonly referralsOpened: number;
  readonly referralsQualified: number;
  readonly referralsReversed: number;
  readonly bountyCost: Money;
  readonly deliveredMargin: Money;
  readonly net: Money;
}

export function performanceFor(
  context: Context,
  program: ProgramId,
  currency: Currency,
): Result<AdvocatePerformance[]> {
  const rows: AdvocatePerformance[] = [];
  for (const advocate of enrolledAdvocates(context.store, program)) {
    const referrals = context.store.referrals.by('advocate', advocate.id);
    if (!referrals.ok) {
      return referrals;
    }
    const mine = referrals.value.filter((row) => row.program === program);
    const margins: Money[] = [];
    for (const referral of mine) {
      const loads = deliveredLoadsOf(context, referral.invitee as CarrierId);
      if (!loads.ok) {
        return loads;
      }
      for (const load of loads.value) {
        margins.push(grossMargin(load));
      }
    }
    const cost = money(
      currency,
      accrualsOfAdvocate(context.store, advocate.id).reduce(
        (running, row) => running + row.amountMinor,
        0,
      ),
    );
    const delivered = sum(margins, currency);
    rows.push({
      advocate: advocate.id,
      referralsOpened: mine.length,
      referralsQualified: mine.filter((row) => row.state === 'qualified').length,
      referralsReversed: mine.filter((row) => row.state === 'reversed').length,
      bountyCost: cost,
      deliveredMargin: delivered,
      net: subtract(delivered, cost),
    });
  }
  return ok(sorted(rows, (left, right) => byText(left.advocate, right.advocate)));
}

export function performanceReport(
  rows: readonly AdvocatePerformance[],
  currency: Currency,
): Report<AdvocatePerformance> {
  const cost = sum(
    rows.map((row) => row.bountyCost),
    currency,
  );
  const margin = sum(
    rows.map((row) => row.deliveredMargin),
    currency,
  );
  return {
    title: 'program performance by advocate',
    columns: [
      textColumn<AdvocatePerformance>('advocate', 'advocate', (row) => row.advocate),
      numberColumn<AdvocatePerformance>('opened', 'opened', (row) => row.referralsOpened),
      numberColumn<AdvocatePerformance>('qualified', 'qualified', (row) => row.referralsQualified),
      numberColumn<AdvocatePerformance>('reversed', 'reversed', (row) => row.referralsReversed),
      moneyColumn<AdvocatePerformance>('cost', 'bounty', (row) => row.bountyCost),
      moneyColumn<AdvocatePerformance>('margin', 'margin', (row) => row.deliveredMargin),
      moneyColumn<AdvocatePerformance>('net', 'net', (row) => row.net),
    ],
    rows,
    footnotes: [
      `bounty ${cost.minor} against margin ${margin.minor} minor units`,
      'margin is what the invited carriers actually delivered, not a forecast',
    ],
  };
}

export function qualifyRate(rows: readonly AdvocatePerformance[]): number {
  const opened = rows.reduce((running, row) => running + row.referralsOpened, 0);
  const qualified = rows.reduce((running, row) => running + row.referralsQualified, 0);
  return opened === 0 ? 0 : qualified / opened;
}

export function reversalRate(rows: readonly AdvocatePerformance[]): number {
  const qualified = rows.reduce(
    (running, row) => running + row.referralsQualified + row.referralsReversed,
    0,
  );
  const reversed = rows.reduce((running, row) => running + row.referralsReversed, 0);
  return qualified === 0 ? 0 : reversed / qualified;
}

export function totalNet(rows: readonly AdvocatePerformance[], currency: Currency): Money {
  return sum(
    rows.map((row) => row.net),
    currency,
  );
}
