import { describe, expect, it } from 'vitest';
import { money, sum } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';
import {
  ONE_HUNDRED_PERCENT,
  addRates,
  allocate,
  applyRate,
  basisPoints,
  clampRate,
  formatBasisPoints,
  parseBasisPoints,
  scale,
} from '../../src/util/rate.js';

describe('basisPoints', () => {
  it('accepts an integer', () => {
    expect(basisPoints(625)).toBe(625);
  });

  it('refuses a fraction', () => {
    expect(() => basisPoints(6.25)).toThrow(/must be an integer/);
  });

  it('names one hundred percent', () => {
    expect(ONE_HUNDRED_PERCENT).toBe(10_000);
  });
});

describe('parsing rates', () => {
  it('reads a percentage', () => {
    expect(unwrap(parseBasisPoints('6.25%'))).toBe(625);
    expect(unwrap(parseBasisPoints('12%'))).toBe(1200);
    expect(unwrap(parseBasisPoints('0.5%'))).toBe(50);
  });

  it('reads a negative percentage', () => {
    expect(unwrap(parseBasisPoints('-2.50%'))).toBe(-250);
  });

  it('reads basis points directly', () => {
    expect(unwrap(parseBasisPoints('625 bps'))).toBe(625);
    expect(unwrap(parseBasisPoints('-40bps'))).toBe(-40);
  });

  it('rejects junk', () => {
    expect(isErr(parseBasisPoints('six percent'))).toBe(true);
  });

  it('round trips through format', () => {
    expect(formatBasisPoints(unwrap(parseBasisPoints('6.25%')))).toBe('6.25%');
    expect(formatBasisPoints(-250)).toBe('-2.50%');
  });
});

describe('applyRate rounding', () => {
  it('rounds half up by default', () => {
    expect(applyRate(money('USD', 1005), 5000).minor).toBe(503);
  });

  it('rounds half even when asked', () => {
    expect(applyRate(money('USD', 1005), 5000, 'half_even').minor).toBe(502);
    expect(applyRate(money('USD', 3015), 5000, 'half_even').minor).toBe(1508);
  });

  it('rounds down and up when asked', () => {
    expect(applyRate(money('USD', 1005), 5000, 'down').minor).toBe(502);
    expect(applyRate(money('USD', 1001), 5000, 'up').minor).toBe(501);
  });

  it('leaves an exact result alone under every mode', () => {
    for (const mode of ['half_up', 'half_even', 'down', 'up'] as const) {
      expect(applyRate(money('USD', 2000), 5000, mode).minor).toBe(1000);
    }
  });

  it('rounds a negative amount away from zero on half up', () => {
    expect(applyRate(money('USD', -1005), 5000).minor).toBe(-503);
  });

  it('keeps the currency', () => {
    expect(applyRate(money('CAD', 10_000), 250).currency).toBe('CAD');
  });
});

describe('scale', () => {
  it('prorates', () => {
    expect(scale(money('USD', 10_000), 1, 3).minor).toBe(3333);
    expect(scale(money('USD', 10_000), 2, 3).minor).toBe(6667);
  });

  it('refuses a zero denominator', () => {
    expect(() => scale(money('USD', 1), 1, 0)).toThrow(/zero denominator/);
  });
});

describe('allocate', () => {
  it('adds back to the original', () => {
    const parts = allocate(money('USD', 10_000), [1, 1, 1]);
    expect(parts.map((p) => p.minor)).toEqual([3334, 3333, 3333]);
    expect(sum(parts, 'USD').minor).toBe(10_000);
  });

  it('respects weights', () => {
    const parts = allocate(money('USD', 1000), [3, 1]);
    expect(parts.map((p) => p.minor)).toEqual([750, 250]);
  });

  it('gives nothing to a zero weight', () => {
    const parts = allocate(money('USD', 1001), [1, 0, 1]);
    expect(parts[1]!.minor).toBe(0);
    expect(sum(parts, 'USD').minor).toBe(1001);
  });

  it('handles an all zero weight list', () => {
    const parts = allocate(money('USD', 500), [0, 0]);
    expect(parts.map((p) => p.minor)).toEqual([0, 0]);
  });

  it('handles an empty weight list', () => {
    expect(allocate(money('USD', 500), [])).toEqual([]);
  });

  it('allocates a negative amount and still adds back', () => {
    const parts = allocate(money('USD', -1000), [1, 1, 1]);
    expect(sum(parts, 'USD').minor).toBe(-1000);
  });

  it('refuses a negative weight', () => {
    expect(() => allocate(money('USD', 100), [1, -1])).toThrow(/cannot be negative/);
  });
});

describe('rate arithmetic', () => {
  it('adds', () => {
    expect(addRates(500, 125)).toBe(625);
  });

  it('clamps', () => {
    expect(clampRate(900, 100, 500)).toBe(500);
    expect(clampRate(50, 100, 500)).toBe(100);
    expect(clampRate(300, 100, 500)).toBe(300);
  });

  it('refuses inverted bounds', () => {
    expect(() => clampRate(1, 5, 2)).toThrow(/inverted/);
  });
});
