/**
 * Reconciliation. Three numbers have to agree and they are produced by three
 * different parts of the program, so this is where they are put next to each
 * other and the difference is named.
 *
 * What the ladder says an advocate is owed, what the accrual table adds up to,
 * and what the settlement batches have paid plus what is still outstanding.
 * When they disagree the answer is never to adjust one of them. It is to find
 * out which one is wrong, and a reconciliation that reports a single net figure
 * cannot tell you that, so this one reports all three.
 */

import type { DayInterval } from '../util/interval.js';
import { money, subtract, type Currency, type Money } from '../util/money.js';
import { byText, sorted } from '../util/ordering.js';
import { ok, type Result } from '../util/result.js';
import type { AdvocateId, ProgramId } from '../domain/identity.js';
import { runLadder, totalPosted } from '../domain/ladder.js';
import { scheduleFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';
import { ladderEntriesOf } from './accrualEngine.js';
import { qualifiedReferralsOf } from './cycle.js';
import { accrualsInProgramYear, enrolledAdvocates } from '../storage/repositories.js';
import { formatDay, type Day } from '../util/clock.js';

export interface AdvocateReconciliation {
  readonly advocate: string;
  readonly ladderSays: Money;
  readonly accrualsSay: Money;
  readonly difference: Money;
  readonly agrees: boolean;
}

export interface ReconciliationReport {
  readonly rows: readonly AdvocateReconciliation[];
  readonly disagreements: number;
  readonly worst: Money;
}

export function reconcileAdvocate(
  context: Context,
  catalog: Catalog,
  advocate: AdvocateId,
  program: ProgramId,
  programYear: DayInterval,
  programYearFrom: Day,
  currency: Currency,
): Result<AdvocateReconciliation> {
  const schedule = scheduleFor(catalog, program, programYearFrom);
  if (!schedule.ok) {
    return schedule;
  }
  const referrals = qualifiedReferralsOf(context, catalog, advocate, program, programYear);
  if (!referrals.ok) {
    return referrals;
  }
  const run = runLadder(schedule.value, ladderEntriesOf(referrals.value));
  if (!run.ok) {
    return run;
  }
  const ladderSays = totalPosted(run.value, currency);
  const postedMinor = accrualsInProgramYear(
    context.store,
    advocate,
    formatDay(programYearFrom),
  ).reduce((running, row) => running + row.amountMinor, 0);
  const accrualsSay = money(currency, postedMinor);
  const difference = subtract(ladderSays, accrualsSay);
  return ok({
    advocate,
    ladderSays,
    accrualsSay,
    difference,
    agrees: difference.minor === 0,
  });
}

export function reconcileProgram(
  context: Context,
  catalog: Catalog,
  program: ProgramId,
  programYear: DayInterval,
  programYearFrom: Day,
  currency: Currency,
): Result<ReconciliationReport> {
  const rows: AdvocateReconciliation[] = [];
  for (const advocate of enrolledAdvocates(context.store, program)) {
    const row = reconcileAdvocate(
      context,
      catalog,
      advocate.id as AdvocateId,
      program,
      programYear,
      programYearFrom,
      currency,
    );
    if (!row.ok) {
      return row;
    }
    rows.push(row.value);
  }
  const ordered = sorted(rows, (left, right) => byText(left.advocate, right.advocate));
  let worst = 0;
  for (const row of ordered) {
    worst = Math.max(worst, Math.abs(row.difference.minor));
  }
  return ok({
    rows: ordered,
    disagreements: ordered.filter((row) => !row.agrees).length,
    worst: money(currency, worst),
  });
}

export function balanced(report: ReconciliationReport): boolean {
  return report.disagreements === 0;
}

export function describeReconciliation(report: ReconciliationReport): string {
  return balanced(report)
    ? `${report.rows.length} advocates, everything agrees`
    : `${report.disagreements} of ${report.rows.length} advocates disagree, worst ${report.worst.minor}`;
}
