import { describe, expect, it } from 'vitest';
import {
  requireAllCurrency,
  requireCurrency,
  requireNotNegative,
  requireWholeCount,
  requireWholeDays,
} from '../../src/domain/rules.js';
import { money } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

describe('requireWholeDays', () => {
  it('accepts a positive whole number', () => {
    expect(unwrap(requireWholeDays('code', 'cure window', 21))).toBe(21);
  });

  it('rejects zero, a negative and a fraction', () => {
    expect(isErr(requireWholeDays('code', 'cure window', 0))).toBe(true);
    expect(isErr(requireWholeDays('code', 'cure window', -1))).toBe(true);
    expect(isErr(requireWholeDays('code', 'cure window', 2.5))).toBe(true);
  });

  it('names the label and the value it saw', () => {
    const r = requireWholeDays('code', 'cure window', 0);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('cure window');
      expect(r.problems[0]!.message).toContain('0');
      expect(r.problems[0]!.code).toBe('code');
    }
  });
});

describe('requireWholeCount', () => {
  it('accepts a positive whole number', () => {
    expect(unwrap(requireWholeCount('code', 'load count', 6))).toBe(6);
  });

  it('does not say days', () => {
    const r = requireWholeCount('code', 'load count', 0);
    if (isErr(r)) {
      expect(r.problems[0]!.message).not.toContain('days');
    }
  });
});

describe('requireCurrency', () => {
  it('accepts a matching currency', () => {
    expect(unwrap(requireCurrency('code', 'USD', money('USD', 1), 'margin')).minor).toBe(1);
  });

  it('rejects a mismatch and names both sides', () => {
    const r = requireCurrency('code', 'USD', money('CAD', 1), 'the margin');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('CAD');
      expect(r.problems[0]!.message).toContain('USD');
      expect(r.problems[0]!.message).toContain('the margin');
    }
  });
});

describe('requireAllCurrency', () => {
  const rows = [
    { name: 'one', currency: 'USD' as const },
    { name: 'two', currency: 'USD' as const },
  ];

  it('accepts a list that agrees', () => {
    expect(
      unwrap(
        requireAllCurrency(
          'code',
          'USD',
          rows,
          (row) => row.currency,
          (row) => row.name,
        ),
      ),
    ).toHaveLength(2);
  });

  it('accepts an empty list', () => {
    expect(
      unwrap(
        requireAllCurrency(
          'code',
          'USD',
          [],
          () => 'USD' as const,
          () => 'nothing',
        ),
      ),
    ).toHaveLength(0);
  });

  it('names the first row that disagrees', () => {
    const mixed = [...rows, { name: 'three', currency: 'MXN' as const }];
    const r = requireAllCurrency(
      'code',
      'USD',
      mixed,
      (row) => row.currency,
      (row) => row.name,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('three');
    }
  });
});

describe('requireNotNegative', () => {
  it('accepts zero and above', () => {
    expect(unwrap(requireNotNegative('code', 'amount', 0))).toBe(0);
    expect(unwrap(requireNotNegative('code', 'amount', 5))).toBe(5);
  });

  it('rejects below zero', () => {
    const r = requireNotNegative('code', 'a settlement', -1);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('a settlement');
    }
  });
});
