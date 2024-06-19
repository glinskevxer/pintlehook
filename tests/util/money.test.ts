import { describe, expect, it } from 'vitest';
import {
  absolute,
  add,
  compareMoney,
  equalsMoney,
  floorAtZero,
  formatMoney,
  isCurrency,
  isNegative,
  isPositive,
  isZero,
  maxMoney,
  minMoney,
  minorDigits,
  money,
  negate,
  parseMoney,
  subtract,
  sum,
  zero,
} from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

describe('money', () => {
  it('rejects a non integer minor amount', () => {
    expect(() => money('USD', 12.5)).toThrow(/safe integer/);
  });

  it('builds a zero', () => {
    expect(zero('CAD')).toEqual({ currency: 'CAD', minor: 0 });
  });

  it('reports sign', () => {
    expect(isZero(zero('USD'))).toBe(true);
    expect(isNegative(money('USD', -1))).toBe(true);
    expect(isPositive(money('USD', 1))).toBe(true);
    expect(isPositive(zero('USD'))).toBe(false);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(add(money('USD', 250), money('USD', 125))).toEqual(money('USD', 375));
    expect(subtract(money('USD', 250), money('USD', 300))).toEqual(money('USD', -50));
  });

  it('refuses to add across currencies', () => {
    expect(() => add(money('USD', 1), money('CAD', 1))).toThrow(/currency mismatch/);
  });

  it('negates and takes absolute value', () => {
    expect(negate(money('USD', -400))).toEqual(money('USD', 400));
    expect(absolute(money('USD', -400))).toEqual(money('USD', 400));
  });

  it('sums an empty list to zero of the stated currency', () => {
    expect(sum([], 'MXN')).toEqual(zero('MXN'));
  });

  it('sums many values', () => {
    const values = [money('USD', 100), money('USD', 250), money('USD', -75)];
    expect(sum(values, 'USD')).toEqual(money('USD', 275));
  });

  it('refuses a mixed currency sum', () => {
    expect(() => sum([money('USD', 1), money('CAD', 1)], 'USD')).toThrow(/currency mismatch/);
  });
});

describe('comparison', () => {
  it('orders by minor units', () => {
    expect(compareMoney(money('USD', 10), money('USD', 20))).toBeLessThan(0);
    expect(compareMoney(money('USD', 20), money('USD', 20))).toBe(0);
  });

  it('takes max and min', () => {
    expect(maxMoney(money('USD', 5), money('USD', 9))).toEqual(money('USD', 9));
    expect(minMoney(money('USD', 5), money('USD', 9))).toEqual(money('USD', 5));
  });

  it('compares equality including currency', () => {
    expect(equalsMoney(money('USD', 5), money('USD', 5))).toBe(true);
    expect(equalsMoney(money('USD', 5), money('CAD', 5))).toBe(false);
  });

  it('floors a negative at zero and leaves a positive alone', () => {
    expect(floorAtZero(money('USD', -500))).toEqual(zero('USD'));
    expect(floorAtZero(money('USD', 500))).toEqual(money('USD', 500));
  });
});

describe('formatting', () => {
  it('formats whole and fractional parts', () => {
    expect(formatMoney(money('USD', 125000))).toBe('1250.00 USD');
    expect(formatMoney(money('USD', 5))).toBe('0.05 USD');
  });

  it('formats a negative with a leading sign', () => {
    expect(formatMoney(money('CAD', -12345))).toBe('-123.45 CAD');
  });
});

describe('parsing', () => {
  it('round trips through format', () => {
    const original = money('USD', 987654);
    expect(unwrap(parseMoney(formatMoney(original)))).toEqual(original);
  });

  it('accepts a missing fractional part', () => {
    expect(unwrap(parseMoney('40 USD'))).toEqual(money('USD', 4000));
  });

  it('accepts a single fractional digit', () => {
    expect(unwrap(parseMoney('40.5 USD'))).toEqual(money('USD', 4050));
  });

  it('rejects junk', () => {
    expect(isErr(parseMoney('forty dollars'))).toBe(true);
  });

  it('rejects an unknown currency', () => {
    const r = parseMoney('10.00 GBP');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('money_currency_unknown');
    }
  });

  it('rejects three fractional digits', () => {
    expect(isErr(parseMoney('10.005 USD'))).toBe(true);
  });
});

describe('currency helpers', () => {
  it('recognises supported codes', () => {
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('JPY')).toBe(false);
  });

  it('reports minor digits', () => {
    expect(minorDigits('USD')).toBe(2);
  });
});
