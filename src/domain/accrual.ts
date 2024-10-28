/**
 * An accrual is one posting against one advocate: what the program owes and
 * why. Everything the ladder produces becomes an accrual, and so does every
 * reversal, so the advocate's position is always the sum of a list rather than
 * a running figure somebody has to keep straight.
 *
 * Accruals are never edited. A wrong accrual is answered with a contra accrual
 * that points back at it, which is what makes a statement reconcilable months
 * after the fact.
 */

import { compareDays, type Day } from '../util/clock.js';
import { isNegative, money, sum, zero, type Currency, type Money } from '../util/money.js';
import { byKey, byText, chain, groupBy, sorted } from '../util/ordering.js';
import type { Comparator } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AccrualId, AdvocateId, ProgramId } from './identity.js';

export type AccrualKind = 'base' | 'true_up' | 'true_down' | 'reversal' | 'recovery' | 'adjustment';

export const CREDIT_KINDS: readonly AccrualKind[] = ['base', 'true_up'];
export const DEBIT_KINDS: readonly AccrualKind[] = ['true_down', 'reversal', 'recovery'];

export interface Accrual {
  readonly id: AccrualId;
  readonly advocate: AdvocateId;
  readonly program: ProgramId;
  /** The referral this posting belongs to. */
  readonly referralKey: string;
  readonly kind: AccrualKind;
  readonly postedOn: Day;
  /** The program year the posting falls in, named by its first day. */
  readonly programYearFrom: Day;
  readonly amount: Money;
  /** Set on a contra posting, naming the accrual it answers. */
  readonly reverses?: AccrualId | undefined;
  readonly note: string;
}

export const accrualOrder: Comparator<Accrual> = chain(
  byKey((a: Accrual) => a.postedOn, compareDays),
  byKey((a: Accrual) => a.referralKey, byText),
  byKey((a: Accrual) => a.id as string, byText),
);

export function isCredit(accrual: Accrual): boolean {
  return (CREDIT_KINDS as readonly string[]).includes(accrual.kind);
}

export function isDebit(accrual: Accrual): boolean {
  return (DEBIT_KINDS as readonly string[]).includes(accrual.kind);
}

export function balanceOf(accruals: readonly Accrual[], currency: Currency): Money {
  return sum(
    accruals.map((accrual) => accrual.amount),
    currency,
  );
}

export function balanceByProgramYear(
  accruals: readonly Accrual[],
  currency: Currency,
): Map<string, Money> {
  const grouped = groupBy(accruals, (accrual) => yearKey(accrual.programYearFrom));
  const balances = new Map<string, Money>();
  for (const [key, group] of grouped) {
    balances.set(key, balanceOf(group, currency));
  }
  return balances;
}

export function yearKey(from: Day): string {
  const month = String(from.month).padStart(2, '0');
  const dayOfMonth = String(from.dayOfMonth).padStart(2, '0');
  return `${from.year}-${month}-${dayOfMonth}`;
}

export function balanceForReferral(
  accruals: readonly Accrual[],
  referralKey: string,
  currency: Currency,
): Money {
  return balanceOf(
    accruals.filter((accrual) => accrual.referralKey === referralKey),
    currency,
  );
}

/** Accruals in posting order up to and including a day, for a point in time view. */
export function asOf(accruals: readonly Accrual[], when: Day): Accrual[] {
  return sorted(
    accruals.filter((accrual) => compareDays(accrual.postedOn, when) <= 0),
    accrualOrder,
  );
}

export function validateAccrual(accrual: Accrual): Result<Accrual> {
  if (accrual.referralKey.trim() === '') {
    return fail('accrual_referral_missing', 'an accrual has to name the referral it belongs to');
  }
  if (isCredit(accrual) && isNegative(accrual.amount)) {
    return fail('accrual_credit_negative', `a ${accrual.kind} posting cannot be negative`);
  }
  if (isDebit(accrual) && accrual.amount.minor > 0) {
    return fail('accrual_debit_positive', `a ${accrual.kind} posting cannot be positive`);
  }
  if (accrual.kind === 'reversal' && accrual.reverses === undefined) {
    return fail('accrual_reversal_unlinked', 'a reversal has to name the accrual it answers');
  }
  if (accrual.reverses !== undefined && accrual.reverses === accrual.id) {
    return fail('accrual_reverses_itself', 'an accrual cannot reverse itself');
  }
  return ok(accrual);
}

export function contra(accrual: Accrual, id: AccrualId, postedOn: Day, note: string): Accrual {
  return {
    id,
    advocate: accrual.advocate,
    program: accrual.program,
    referralKey: accrual.referralKey,
    kind: 'reversal',
    postedOn,
    programYearFrom: accrual.programYearFrom,
    amount: money(accrual.amount.currency, -accrual.amount.minor),
    reverses: accrual.id,
    note,
  };
}

export function netZero(accruals: readonly Accrual[], currency: Currency): boolean {
  return balanceOf(accruals, currency).minor === zero(currency).minor;
}
