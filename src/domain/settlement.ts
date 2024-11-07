/**
 * Settlement. Accruals are cut into batches on a settlement calendar, one line
 * per advocate, and the batch is the thing the accounts payable run consumes.
 *
 * A line is built from the accruals that fall in the period, but what it pays
 * is the advocate's whole net position, because a reversal posted in this
 * period can answer an accrual paid in the last one. So the line carries both
 * numbers and the register prints both.
 */

import { compareDays, type Day } from '../util/clock.js';
import { contains, type DayInterval } from '../util/interval.js';
import { add, subtract, sum, zero, type Currency, type Money } from '../util/money.js';
import { byKey, byText, chain, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import { balanceOf, type Accrual } from './accrual.js';
import type { AdvocateId, BatchId, SettlementId } from './identity.js';
import type { HoldVerdict } from './hold.js';

export type BatchState = 'open' | 'cut' | 'released' | 'paid' | 'void';

export interface SettlementLine {
  readonly id: SettlementId;
  readonly advocate: AdvocateId;
  /** Accruals posted inside the period. */
  readonly periodAccruals: Money;
  /** Everything not yet settled, which is what actually goes out. */
  readonly netPosition: Money;
  readonly withheld: Money;
  readonly payable: Money;
  readonly hold: HoldVerdict;
  readonly accrualIds: readonly string[];
}

export interface SettlementBatch {
  readonly id: BatchId;
  readonly period: DayInterval;
  readonly cutOn: Day;
  readonly state: BatchState;
  readonly currency: Currency;
  readonly lines: readonly SettlementLine[];
}

const ALLOWED: Record<BatchState, readonly BatchState[]> = {
  open: ['cut', 'void'],
  cut: ['released', 'void'],
  released: ['paid', 'void'],
  paid: [],
  void: [],
};

export function canMoveBatch(from: BatchState, to: BatchState): boolean {
  return (ALLOWED[from] as readonly string[]).includes(to);
}

export function moveBatch(batch: SettlementBatch, to: BatchState): Result<SettlementBatch> {
  if (batch.state === to) {
    return ok(batch);
  }
  if (!canMoveBatch(batch.state, to)) {
    return fail('batch_bad_transition', `a batch cannot go from ${batch.state} to ${to}`);
  }
  return ok({ ...batch, state: to });
}

export const lineOrder = chain(
  byKey(
    (line: SettlementLine) => (line.hold.held ? 1 : 0),
    (a: number, b: number) => a - b,
  ),
  byKey((line: SettlementLine) => line.advocate as string, byText),
);

export function accrualsInPeriod(accruals: readonly Accrual[], period: DayInterval): Accrual[] {
  return accruals.filter((accrual) => contains(period, accrual.postedOn));
}

export function buildLine(
  id: SettlementId,
  advocate: AdvocateId,
  periodAccrualList: readonly Accrual[],
  netPosition: Money,
  withheld: Money,
  hold: HoldVerdict,
  currency: Currency,
): Result<SettlementLine> {
  if (netPosition.currency !== currency || withheld.currency !== currency) {
    return fail('settlement_currency_mismatch', 'a line has to be in the currency of its batch');
  }
  if (withheld.minor < 0) {
    return fail('settlement_withholding_negative', 'a withholding cannot be negative');
  }
  const payable = hold.held ? zero(currency) : subtract(netPosition, withheld);
  return ok({
    id,
    advocate,
    periodAccruals: balanceOf(periodAccrualList, currency),
    netPosition,
    withheld,
    payable,
    hold,
    accrualIds: periodAccrualList.map((accrual) => accrual.id as string),
  });
}

export function batchTotal(batch: SettlementBatch): Money {
  return sum(
    batch.lines.map((line) => line.payable),
    batch.currency,
  );
}

export function batchWithheld(batch: SettlementBatch): Money {
  return sum(
    batch.lines.map((line) => line.withheld),
    batch.currency,
  );
}

export function heldLines(batch: SettlementBatch): SettlementLine[] {
  return sorted(
    batch.lines.filter((line) => line.hold.held),
    lineOrder,
  );
}

export function payableLines(batch: SettlementBatch): SettlementLine[] {
  return sorted(
    batch.lines.filter((line) => !line.hold.held && line.payable.minor > 0),
    lineOrder,
  );
}

export function validateBatch(batch: SettlementBatch): Result<SettlementBatch> {
  if (compareDays(batch.cutOn, batch.period.until) < 0) {
    return fail('batch_cut_before_period_end', 'a batch cannot be cut before its period closes');
  }
  const seen = new Set<string>();
  for (const line of batch.lines) {
    if (seen.has(line.advocate)) {
      return fail('batch_advocate_twice', `advocate ${line.advocate} appears on two lines`);
    }
    seen.add(line.advocate);
    if (line.payable.currency !== batch.currency) {
      return fail('settlement_currency_mismatch', 'a line is in another currency');
    }
    if (line.hold.held && line.payable.minor !== 0) {
      return fail('batch_held_line_pays', 'a held line cannot carry an amount to pay');
    }
  }
  return ok(batch);
}

export function grossOf(line: SettlementLine): Money {
  return add(line.payable, line.withheld);
}
