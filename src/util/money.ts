/**
 * Money is an integer count of minor units plus a currency. There is no
 * floating point money anywhere in this codebase, because a bounty ladder that
 * re-rates history has to add and subtract the same numbers many times and
 * still land on the cent the settlement register printed.
 */

import { fail, ok, type Result } from './result.js';

export type Currency = 'USD' | 'CAD' | 'MXN';

export interface Money {
  readonly currency: Currency;
  readonly minor: number;
}

const MINOR_DIGITS: Record<Currency, number> = { USD: 2, CAD: 2, MXN: 2 };

export const CURRENCIES: readonly Currency[] = ['USD', 'CAD', 'MXN'];

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

export function money(currency: Currency, minor: number): Money {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`money minor units must be a safe integer, got ${minor}`);
  }
  return { currency, minor };
}

export function zero(currency: Currency): Money {
  return { currency, minor: 0 };
}

export function isZero(value: Money): boolean {
  return value.minor === 0;
}

export function isNegative(value: Money): boolean {
  return value.minor < 0;
}

export function isPositive(value: Money): boolean {
  return value.minor > 0;
}

function requireSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new Error(`currency mismatch: ${left.currency} against ${right.currency}`);
  }
}

export function add(left: Money, right: Money): Money {
  requireSameCurrency(left, right);
  return money(left.currency, left.minor + right.minor);
}

export function subtract(left: Money, right: Money): Money {
  requireSameCurrency(left, right);
  return money(left.currency, left.minor - right.minor);
}

export function negate(value: Money): Money {
  return money(value.currency, -value.minor);
}

export function absolute(value: Money): Money {
  return money(value.currency, Math.abs(value.minor));
}

export function sum(values: readonly Money[], currency: Currency): Money {
  let total = 0;
  for (const value of values) {
    if (value.currency !== currency) {
      throw new Error(`currency mismatch in sum: ${value.currency} against ${currency}`);
    }
    total += value.minor;
  }
  return money(currency, total);
}

export function compareMoney(left: Money, right: Money): number {
  requireSameCurrency(left, right);
  return left.minor - right.minor;
}

export function maxMoney(left: Money, right: Money): Money {
  return compareMoney(left, right) >= 0 ? left : right;
}

export function minMoney(left: Money, right: Money): Money {
  return compareMoney(left, right) <= 0 ? left : right;
}

export function equalsMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.minor === right.minor;
}

/** Clamp to zero from below. Used where a recovery cannot make a payout negative. */
export function floorAtZero(value: Money): Money {
  return value.minor < 0 ? zero(value.currency) : value;
}

export function formatMoney(value: Money): string {
  const digits = MINOR_DIGITS[value.currency];
  const scale = 10 ** digits;
  const sign = value.minor < 0 ? '-' : '';
  const abs = Math.abs(value.minor);
  const whole = Math.trunc(abs / scale);
  const frac = String(abs % scale).padStart(digits, '0');
  return `${sign}${whole}.${frac} ${value.currency}`;
}

const MONEY_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?\s+([A-Z]{3})$/;

export function parseMoney(text: string): Result<Money> {
  const match = MONEY_PATTERN.exec(text.trim());
  if (match === null) {
    return fail('money_unparseable', `cannot read "${text}" as money`);
  }
  const [, sign, whole, frac, code] = match;
  if (code === undefined || !isCurrency(code)) {
    return fail('money_currency_unknown', `unknown currency ${code ?? ''}`);
  }
  const digits = MINOR_DIGITS[code];
  const fracPart = (frac ?? '').padEnd(digits, '0');
  const minor = Number(whole) * 10 ** digits + Number(fracPart === '' ? '0' : fracPart);
  return ok(money(code, sign === '-' ? -minor : minor));
}

export function minorDigits(currency: Currency): number {
  return MINOR_DIGITS[currency];
}
