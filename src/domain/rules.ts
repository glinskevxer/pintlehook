/**
 * The checks the rule modules kept writing out by hand. Window lengths and
 * currency agreement were repeated in seven places with seven slightly
 * different messages, which is exactly the sort of drift that makes two
 * failures look like one bug.
 */

import { fail, ok, type Result } from '../util/result.js';
import type { Currency, Money } from '../util/money.js';

/** A window, checkpoint or cure period: a positive whole number of days. */
export function requireWholeDays(code: string, label: string, days: number): Result<number> {
  if (!Number.isInteger(days) || days <= 0) {
    return fail(code, `the ${label} must be a positive whole number of days, got ${days}`);
  }
  return ok(days);
}

/** A count of things, which is also a positive whole number but reads better. */
export function requireWholeCount(code: string, label: string, count: number): Result<number> {
  if (!Number.isInteger(count) || count <= 0) {
    return fail(code, `the ${label} must be a positive whole number, got ${count}`);
  }
  return ok(count);
}

export function requireCurrency(
  code: string,
  expected: Currency,
  amount: Money,
  label: string,
): Result<Money> {
  if (amount.currency !== expected) {
    return fail(code, `${label} is in ${amount.currency} against ${expected}`);
  }
  return ok(amount);
}

export function requireAllCurrency<T>(
  code: string,
  expected: Currency,
  values: readonly T[],
  read: (value: T) => Currency,
  label: (value: T) => string,
): Result<readonly T[]> {
  for (const value of values) {
    const found = read(value);
    if (found !== expected) {
      return fail(code, `${label(value)} is in ${found} against ${expected}`);
    }
  }
  return ok(values);
}

export function requireNotNegative(code: string, label: string, minor: number): Result<number> {
  if (minor < 0) {
    return fail(code, `${label} cannot be negative`);
  }
  return ok(minor);
}
