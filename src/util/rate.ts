/**
 * Rates are basis points, integers, one hundredth of a percent. A bounty rate
 * of six and a quarter percent is 625 and never 0.0625, and applying it names
 * its rounding mode at the call site rather than inheriting one.
 */

import { money, type Money } from './money.js';
import { fail, ok, type Result } from './result.js';

export type BasisPoints = number;

export const ONE_HUNDRED_PERCENT: BasisPoints = 10_000;

export type Rounding = 'half_up' | 'half_even' | 'down' | 'up';

export function basisPoints(value: number): BasisPoints {
  if (!Number.isInteger(value)) {
    throw new Error(`basis points must be an integer, got ${value}`);
  }
  return value;
}

export function parseBasisPoints(text: string): Result<BasisPoints> {
  const trimmed = text.trim();
  const percentMatch = /^(-?\d+(?:\.\d{1,2})?)%$/.exec(trimmed);
  if (percentMatch !== null) {
    const raw = percentMatch[1] ?? '0';
    const [whole, frac = ''] = raw.split('.');
    const sign = raw.startsWith('-') ? -1 : 1;
    const wholeDigits = Math.abs(Number(whole));
    const fracDigits = Number(frac.padEnd(2, '0') || '0');
    return ok(sign * (wholeDigits * 100 + fracDigits));
  }
  const bpsMatch = /^(-?\d+)\s*bps$/.exec(trimmed);
  if (bpsMatch !== null) {
    return ok(Number(bpsMatch[1]));
  }
  return fail('rate_unparseable', `cannot read "${text}" as a rate`);
}

export function formatBasisPoints(value: BasisPoints): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}%`;
}

function roundQuotient(numerator: number, denominator: number, mode: Rounding): number {
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1;
  const absNumerator = Math.abs(numerator);
  const absDenominator = Math.abs(denominator);
  const whole = Math.trunc(absNumerator / absDenominator);
  const remainder = absNumerator % absDenominator;
  if (remainder === 0) {
    return sign * whole;
  }
  const twice = remainder * 2;
  let rounded = whole;
  switch (mode) {
    case 'down':
      break;
    case 'up':
      rounded = whole + 1;
      break;
    case 'half_up':
      rounded = twice >= absDenominator ? whole + 1 : whole;
      break;
    case 'half_even':
      if (twice > absDenominator) {
        rounded = whole + 1;
      } else if (twice === absDenominator) {
        rounded = whole % 2 === 0 ? whole : whole + 1;
      }
      break;
  }
  return sign * rounded;
}

export function applyRate(amount: Money, rate: BasisPoints, mode: Rounding = 'half_up'): Money {
  return money(amount.currency, roundQuotient(amount.minor * rate, ONE_HUNDRED_PERCENT, mode));
}

export function scale(
  amount: Money,
  numerator: number,
  denominator: number,
  mode: Rounding = 'half_up',
): Money {
  if (denominator === 0) {
    throw new Error('cannot scale by a zero denominator');
  }
  return money(amount.currency, roundQuotient(amount.minor * numerator, denominator, mode));
}

/**
 * Split an amount into shares that add back to exactly the original. The
 * remainder goes to the earliest shares, so a payout register never ends up a
 * cent short of the accrual it came from.
 */
export function allocate(amount: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    return [];
  }
  if (weights.some((w) => w < 0)) {
    throw new Error('allocation weights cannot be negative');
  }
  const total = weights.reduce((acc, w) => acc + w, 0);
  if (total === 0) {
    return weights.map(() => money(amount.currency, 0));
  }
  const shares = weights.map((w) => roundQuotient(amount.minor * w, total, 'down'));
  let allocated = shares.reduce((acc, s) => acc + s, 0);
  let index = 0;
  const step = amount.minor >= allocated ? 1 : -1;
  while (allocated !== amount.minor) {
    const at = index % shares.length;
    const current = shares[at];
    if (current !== undefined && weights[at] !== 0) {
      shares[at] = current + step;
      allocated += step;
    }
    index += 1;
    if (index > shares.length * Math.abs(amount.minor - allocated) + shares.length * 2 + 8) {
      break;
    }
  }
  return shares.map((s) => money(amount.currency, s));
}

export function addRates(left: BasisPoints, right: BasisPoints): BasisPoints {
  return left + right;
}

export function clampRate(value: BasisPoints, low: BasisPoints, high: BasisPoints): BasisPoints {
  if (low > high) {
    throw new Error('clamp bounds are inverted');
  }
  return Math.min(Math.max(value, low), high);
}
