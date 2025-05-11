/**
 * The advocate statement. This is the one report a carrier actually reads, and
 * the thing they want from it is not the total, it is an answer to "why is this
 * different from last month".
 *
 * So it is a running balance with one line per posting and the reason on every
 * line, and a true down reads as a line rather than as a smaller total. A
 * statement that only prints the total is the reason the referral desk spends
 * its mornings on the phone.
 */

import { formatDay, type Day } from '../util/clock.js';
import { money, sum, type Currency, type Money } from '../util/money.js';
import { ok, type Result } from '../util/result.js';
import type { AdvocateId } from '../domain/identity.js';
import { advocateById, accrualsOfAdvocate } from '../storage/repositories.js';
import { requireDayText, type AccrualRow } from '../storage/rows.js';
import type { Context } from '../service/context.js';
import { moneyColumn, textColumn, type Report } from './table.js';

export interface StatementLine {
  readonly postedOn: Day;
  readonly referralKey: string;
  readonly kind: string;
  readonly amount: Money;
  readonly runningBalance: Money;
  readonly note: string;
}

export interface Statement {
  readonly advocate: string;
  readonly referralCode: string;
  readonly lines: readonly StatementLine[];
  readonly closingBalance: Money;
  readonly currency: Currency;
}

export function buildStatement(
  context: Context,
  advocate: AdvocateId,
  currency: Currency,
): Result<Statement> {
  const row = advocateById(context.store, advocate);
  if (!row.ok) {
    return row;
  }
  const lines: StatementLine[] = [];
  let running = 0;
  for (const posting of accrualsOfAdvocate(context.store, advocate)) {
    const postedOn = requireDayText(posting.postedOn, 'postedOn');
    if (!postedOn.ok) {
      return postedOn;
    }
    running += posting.amountMinor;
    lines.push({
      postedOn: postedOn.value,
      referralKey: posting.referralKey,
      kind: posting.kind,
      amount: money(currency, posting.amountMinor),
      runningBalance: money(currency, running),
      note: posting.note,
    });
  }
  return ok({
    advocate,
    referralCode: row.value.referralCode,
    lines,
    closingBalance: money(currency, running),
    currency,
  });
}

export function statementReport(statement: Statement): Report<StatementLine> {
  return {
    title: `statement for ${statement.advocate} on code ${statement.referralCode}`,
    columns: [
      textColumn<StatementLine>('postedOn', 'posted', (line) => formatDay(line.postedOn)),
      textColumn<StatementLine>('referral', 'referral', (line) => line.referralKey),
      textColumn<StatementLine>('kind', 'kind', (line) => line.kind),
      moneyColumn<StatementLine>('amount', 'amount', (line) => line.amount),
      moneyColumn<StatementLine>('balance', 'balance', (line) => line.runningBalance),
      textColumn<StatementLine>('note', 'why', (line) => line.note),
    ],
    rows: statement.lines,
    footnotes: [`closing balance ${statement.closingBalance.minor} minor units`],
  };
}

export function creditsOf(statement: Statement): Money {
  return sum(
    statement.lines.filter((line) => line.amount.minor > 0).map((line) => line.amount),
    statement.currency,
  );
}

export function debitsOf(statement: Statement): Money {
  return sum(
    statement.lines.filter((line) => line.amount.minor < 0).map((line) => line.amount),
    statement.currency,
  );
}

export function referralsOn(statement: Statement): string[] {
  return [...new Set(statement.lines.map((line) => line.referralKey))].sort();
}

/** Does the running balance on the last line agree with the closing figure. */
export function balanceHolds(statement: Statement): boolean {
  const last = statement.lines.at(-1);
  return last === undefined
    ? statement.closingBalance.minor === 0
    : last.runningBalance.minor === statement.closingBalance.minor;
}

export function fromRows(rows: readonly AccrualRow[], currency: Currency): Money {
  return money(
    currency,
    rows.reduce((running, row) => running + row.amountMinor, 0),
  );
}
