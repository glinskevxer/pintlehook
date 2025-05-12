/**
 * The settlement register. One line per advocate on a batch, held lines
 * included and marked, because a register that only prints what is being paid
 * hides exactly the advocates somebody needs to do something about.
 *
 * The register is the document accounts payable works from, so it has to add
 * up on its own: the payable column plus the withheld column has to equal the
 * gross, and the footnote says whether it does.
 */

import { formatDay } from '../util/clock.js';
import { sum, type Money } from '../util/money.js';
import { ok, type Result } from '../util/result.js';
import {
  batchTotal,
  batchWithheld,
  heldLines,
  payableLines,
  type SettlementBatch,
  type SettlementLine,
} from '../domain/settlement.js';
import { moneyColumn, numberColumn, textColumn, type Report } from './table.js';

export interface RegisterSummary {
  readonly lines: number;
  readonly held: number;
  readonly payable: Money;
  readonly withheld: Money;
  readonly gross: Money;
  readonly adds: boolean;
}

export function summarize(batch: SettlementBatch): RegisterSummary {
  const payable = batchTotal(batch);
  const withheld = batchWithheld(batch);
  /**
   * The gross is the net position on the lines that paid, which is a figure
   * this report did not compute. Adding the payable and the withheld back up
   * and comparing against their own sum would agree with itself whatever went
   * wrong, so it has to be checked against something else.
   */
  const gross = sum(
    batch.lines.filter((line) => !line.hold.held).map((line) => line.netPosition),
    batch.currency,
  );
  return {
    lines: batch.lines.length,
    held: heldLines(batch).length,
    payable,
    withheld,
    gross,
    adds: payable.minor + withheld.minor === gross.minor,
  };
}

export function registerReport(batch: SettlementBatch): Report<SettlementLine> {
  const summary = summarize(batch);
  return {
    title: `settlement register for ${batch.id}, period ${formatDay(batch.period.from)} to ${formatDay(batch.period.until)}`,
    columns: [
      textColumn<SettlementLine>('advocate', 'advocate', (line) => line.advocate),
      numberColumn<SettlementLine>('postings', 'postings', (line) => line.accrualIds.length),
      moneyColumn<SettlementLine>('period', 'period', (line) => line.periodAccruals),
      moneyColumn<SettlementLine>('position', 'position', (line) => line.netPosition),
      moneyColumn<SettlementLine>('withheld', 'withheld', (line) => line.withheld),
      moneyColumn<SettlementLine>('payable', 'payable', (line) => line.payable),
      textColumn<SettlementLine>('hold', 'hold', (line) =>
        line.hold.held ? (line.hold.primaryReason ?? 'held') : '',
      ),
    ],
    rows: batch.lines,
    footnotes: [
      `${summary.lines} lines, ${summary.held} held`,
      summary.adds
        ? 'payable plus withheld equals gross'
        : 'WARNING payable plus withheld does not equal gross',
    ],
  };
}

export function heldReport(batch: SettlementBatch): Report<SettlementLine> {
  const held = heldLines(batch);
  return {
    title: `held lines on ${batch.id}`,
    columns: [
      textColumn<SettlementLine>('advocate', 'advocate', (line) => line.advocate),
      moneyColumn<SettlementLine>('position', 'position', (line) => line.netPosition),
      textColumn<SettlementLine>('reasons', 'reasons', (line) => line.hold.reasons.join(', ')),
    ],
    rows: held,
    footnotes: [`${held.length} of ${batch.lines.length} lines are held`],
  };
}

export function payableReport(batch: SettlementBatch): Report<SettlementLine> {
  const payable = payableLines(batch);
  return {
    title: `payable lines on ${batch.id}`,
    columns: [
      textColumn<SettlementLine>('advocate', 'advocate', (line) => line.advocate),
      moneyColumn<SettlementLine>('payable', 'payable', (line) => line.payable),
    ],
    rows: payable,
    footnotes: [`${payable.length} lines to pay`],
  };
}

export function checkRegister(batch: SettlementBatch): Result<RegisterSummary> {
  const summary = summarize(batch);
  return ok(summary);
}

export function biggestLine(batch: SettlementBatch): SettlementLine | undefined {
  let biggest: SettlementLine | undefined;
  for (const line of batch.lines) {
    if (biggest === undefined || line.payable.minor > biggest.payable.minor) {
      biggest = line;
    }
  }
  return biggest;
}
