import { describe, expect, it } from 'vitest';
import {
  CREDIT_KINDS,
  DEBIT_KINDS,
  accrualOrder,
  asOf,
  balanceByProgramYear,
  balanceForReferral,
  balanceOf,
  contra,
  isCredit,
  isDebit,
  netZero,
  validateAccrual,
  yearKey,
  type Accrual,
} from '../../src/domain/accrual.js';
import { accrualId, advocateId, programId } from '../../src/domain/identity.js';
import { day } from '../../src/util/clock.js';
import { money } from '../../src/util/money.js';
import { sorted } from '../../src/util/ordering.js';
import { isErr, unwrap } from '../../src/util/result.js';

function accrual(overrides: Partial<Accrual> = {}): Accrual {
  return {
    id: accrualId(1),
    advocate: advocateId(1),
    program: programId(1),
    referralKey: 'prg_00000001:cxr_00000009',
    kind: 'base',
    postedOn: day(2025, 3, 1),
    programYearFrom: day(2025, 1, 1),
    amount: money('USD', 25_000),
    reverses: undefined,
    note: 'first bounty',
    ...overrides,
  };
}

describe('kinds', () => {
  it('splits credits from debits with no overlap', () => {
    for (const kind of CREDIT_KINDS) {
      expect(DEBIT_KINDS).not.toContain(kind);
    }
  });

  it('reads a posting either way', () => {
    expect(isCredit(accrual())).toBe(true);
    expect(isDebit(accrual())).toBe(false);
    const reversal = accrual({ kind: 'reversal', amount: money('USD', -25_000) });
    expect(isDebit(reversal)).toBe(true);
    expect(isCredit(reversal)).toBe(false);
  });

  it('treats an adjustment as neither, so it can go either way', () => {
    const adjustment = accrual({ kind: 'adjustment', amount: money('USD', -100) });
    expect(isCredit(adjustment)).toBe(false);
    expect(isDebit(adjustment)).toBe(false);
  });
});

describe('balances', () => {
  const postings = [
    accrual({ id: accrualId(1), amount: money('USD', 25_000) }),
    accrual({ id: accrualId(2), kind: 'true_up', amount: money('USD', 16_000) }),
    accrual({
      id: accrualId(3),
      kind: 'reversal',
      amount: money('USD', -41_000),
      reverses: accrualId(1),
    }),
  ];

  it('adds a list of postings', () => {
    expect(balanceOf(postings, 'USD').minor).toBe(0);
    expect(netZero(postings, 'USD')).toBe(true);
  });

  it('is zero for an empty list', () => {
    expect(balanceOf([], 'USD').minor).toBe(0);
  });

  it('adds only the postings for one referral', () => {
    const other = accrual({ id: accrualId(4), referralKey: 'other', amount: money('USD', 9_000) });
    expect(balanceForReferral([...postings, other], 'other', 'USD').minor).toBe(9_000);
  });

  it('splits by program year', () => {
    const nextYear = accrual({
      id: accrualId(5),
      programYearFrom: day(2026, 1, 1),
      amount: money('USD', 7_000),
    });
    const balances = balanceByProgramYear([...postings, nextYear], 'USD');
    expect(balances.get('2025-01-01')!.minor).toBe(0);
    expect(balances.get('2026-01-01')!.minor).toBe(7_000);
  });
});

describe('yearKey', () => {
  it('pads the month and day', () => {
    expect(yearKey(day(2025, 3, 4))).toBe('2025-03-04');
  });
});

describe('accrualOrder', () => {
  it('orders by posting day', () => {
    const later = accrual({ id: accrualId(2), postedOn: day(2025, 4, 1) });
    expect(sorted([later, accrual()], accrualOrder)[0]!.id).toBe(accrualId(1));
  });

  it('breaks a tie on the referral then the identifier', () => {
    const a = accrual({ id: accrualId(2), referralKey: 'aaa' });
    const b = accrual({ id: accrualId(3), referralKey: 'aaa' });
    expect(sorted([b, a], accrualOrder)[0]!.id).toBe(accrualId(2));
  });
});

describe('asOf', () => {
  it('keeps postings up to and including the day', () => {
    const later = accrual({ id: accrualId(2), postedOn: day(2025, 4, 1) });
    expect(asOf([accrual(), later], day(2025, 3, 1))).toHaveLength(1);
    expect(asOf([accrual(), later], day(2025, 4, 1))).toHaveLength(2);
  });

  it('returns them in posting order', () => {
    const later = accrual({ id: accrualId(2), postedOn: day(2025, 4, 1) });
    expect(asOf([later, accrual()], day(2025, 5, 1)).map((a) => a.id)).toEqual([
      accrualId(1),
      accrualId(2),
    ]);
  });
});

describe('validateAccrual', () => {
  it('accepts a good posting', () => {
    expect(unwrap(validateAccrual(accrual()))).toEqual(accrual());
  });

  it('rejects a posting with no referral', () => {
    expect(isErr(validateAccrual(accrual({ referralKey: '  ' })))).toBe(true);
  });

  it('rejects a negative credit', () => {
    const r = validateAccrual(accrual({ amount: money('USD', -1) }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('accrual_credit_negative');
    }
  });

  it('rejects a positive debit', () => {
    const r = validateAccrual(accrual({ kind: 'recovery', amount: money('USD', 1) }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('accrual_debit_positive');
    }
  });

  it('allows a zero debit', () => {
    expect(isErr(validateAccrual(accrual({ kind: 'recovery', amount: money('USD', 0) })))).toBe(
      false,
    );
  });

  it('rejects a reversal that names nothing', () => {
    const r = validateAccrual(accrual({ kind: 'reversal', amount: money('USD', -1) }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('accrual_reversal_unlinked');
    }
  });

  it('rejects a posting that reverses itself', () => {
    const r = validateAccrual(
      accrual({ kind: 'reversal', amount: money('USD', -1), reverses: accrualId(1) }),
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('accrual_reverses_itself');
    }
  });
});

describe('contra', () => {
  it('flips the sign and points back', () => {
    const reversal = contra(accrual(), accrualId(9), day(2025, 6, 1), 'retention failed');
    expect(reversal.amount.minor).toBe(-25_000);
    expect(reversal.reverses).toBe(accrualId(1));
    expect(reversal.kind).toBe('reversal');
  });

  it('keeps the referral and the program year of the original', () => {
    const reversal = contra(accrual(), accrualId(9), day(2025, 6, 1), 'retention failed');
    expect(reversal.referralKey).toBe(accrual().referralKey);
    expect(reversal.programYearFrom).toEqual(day(2025, 1, 1));
  });

  it('nets to nothing against the original', () => {
    const original = accrual();
    const reversal = contra(original, accrualId(9), day(2025, 6, 1), 'retention failed');
    expect(netZero([original, reversal], 'USD')).toBe(true);
  });

  it('passes its own validation', () => {
    const reversal = contra(accrual(), accrualId(9), day(2025, 6, 1), 'retention failed');
    expect(isErr(validateAccrual(reversal))).toBe(false);
  });
});
