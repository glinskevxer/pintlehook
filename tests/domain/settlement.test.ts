import { describe, expect, it } from 'vitest';
import type { Accrual } from '../../src/domain/accrual.js';
import type { HoldVerdict } from '../../src/domain/hold.js';
import {
  accrualId,
  advocateId,
  batchId,
  programId,
  settlementId,
} from '../../src/domain/identity.js';
import {
  accrualsInPeriod,
  batchTotal,
  batchWithheld,
  buildLine,
  canMoveBatch,
  grossOf,
  heldLines,
  moveBatch,
  payableLines,
  validateBatch,
  type SettlementBatch,
} from '../../src/domain/settlement.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { money, zero } from '../../src/util/money.js';
import { isErr, unwrap } from '../../src/util/result.js';

const period = interval(day(2025, 5, 1), day(2025, 6, 1));
const clear: HoldVerdict = { held: false, reasons: [], primaryReason: undefined };
const held: HoldVerdict = {
  held: true,
  reasons: ['negative_position'],
  primaryReason: 'negative_position',
};

function accrual(sequence: number, on: ReturnType<typeof day>, minor: number): Accrual {
  return {
    id: accrualId(sequence),
    advocate: advocateId(1),
    program: programId(1),
    referralKey: 'prg_00000001:cxr_00000009',
    kind: 'base',
    postedOn: on,
    programYearFrom: day(2025, 1, 1),
    amount: money('USD', minor),
    reverses: undefined,
    note: 'bounty',
  };
}

const line = unwrap(
  buildLine(
    settlementId(1),
    advocateId(1),
    [accrual(1, day(2025, 5, 10), 25_000)],
    money('USD', 25_000),
    money('USD', 5_000),
    clear,
    'USD',
  ),
);

const heldLine = unwrap(
  buildLine(settlementId(2), advocateId(2), [], money('USD', -3_000), zero('USD'), held, 'USD'),
);

const batch: SettlementBatch = {
  id: batchId(1),
  period,
  cutOn: day(2025, 6, 2),
  state: 'cut',
  currency: 'USD',
  lines: [line, heldLine],
};

describe('batch states', () => {
  it('allows the forward path', () => {
    expect(canMoveBatch('open', 'cut')).toBe(true);
    expect(canMoveBatch('cut', 'released')).toBe(true);
    expect(canMoveBatch('released', 'paid')).toBe(true);
  });

  it('refuses to skip a step', () => {
    expect(canMoveBatch('open', 'paid')).toBe(false);
  });

  it('lets nothing out of paid', () => {
    expect(canMoveBatch('paid', 'void')).toBe(false);
  });

  it('moves and refuses to move', () => {
    expect(unwrap(moveBatch(batch, 'released')).state).toBe('released');
    expect(unwrap(moveBatch(batch, 'cut')).state).toBe('cut');
    const r = moveBatch(batch, 'paid');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('batch_bad_transition');
    }
  });
});

describe('accrualsInPeriod', () => {
  it('keeps what falls inside the half open period', () => {
    const inside = accrual(1, day(2025, 5, 31), 1);
    const outside = accrual(2, day(2025, 6, 1), 1);
    expect(accrualsInPeriod([inside, outside], period)).toHaveLength(1);
  });
});

describe('buildLine', () => {
  it('pays the net position less the withholding', () => {
    expect(line.payable.minor).toBe(20_000);
    expect(line.periodAccruals.minor).toBe(25_000);
  });

  it('lists the accruals that built it', () => {
    expect(line.accrualIds).toEqual([accrualId(1)]);
  });

  it('pays nothing on a held line', () => {
    expect(heldLine.payable.minor).toBe(0);
  });

  it('refuses a withholding in another currency', () => {
    const r = buildLine(
      settlementId(3),
      advocateId(3),
      [],
      money('USD', 1),
      money('CAD', 1),
      clear,
      'USD',
    );
    expect(isErr(r)).toBe(true);
  });

  it('refuses a negative withholding', () => {
    const r = buildLine(
      settlementId(3),
      advocateId(3),
      [],
      money('USD', 1),
      money('USD', -1),
      clear,
      'USD',
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('settlement_withholding_negative');
    }
  });

  it('carries a period total that can differ from the net position', () => {
    const catchUp = unwrap(
      buildLine(
        settlementId(4),
        advocateId(4),
        [accrual(9, day(2025, 5, 10), -5_000)],
        money('USD', 12_000),
        zero('USD'),
        clear,
        'USD',
      ),
    );
    expect(catchUp.periodAccruals.minor).toBe(-5_000);
    expect(catchUp.payable.minor).toBe(12_000);
  });
});

describe('batch totals', () => {
  it('adds only what is payable', () => {
    expect(batchTotal(batch).minor).toBe(20_000);
  });

  it('adds the withholdings', () => {
    expect(batchWithheld(batch).minor).toBe(5_000);
  });

  it('splits held from payable lines', () => {
    expect(heldLines(batch)).toHaveLength(1);
    expect(payableLines(batch)).toHaveLength(1);
  });

  it('leaves a zero payable line out of the payable list', () => {
    const zeroLine = unwrap(
      buildLine(settlementId(5), advocateId(5), [], zero('USD'), zero('USD'), clear, 'USD'),
    );
    const withZero: SettlementBatch = { ...batch, lines: [...batch.lines, zeroLine] };
    expect(payableLines(withZero)).toHaveLength(1);
  });
});

describe('grossOf', () => {
  it('adds the withholding back on', () => {
    expect(grossOf(line).minor).toBe(25_000);
  });
});

describe('validateBatch', () => {
  it('accepts a good batch', () => {
    expect(unwrap(validateBatch(batch))).toEqual(batch);
  });

  it('refuses a batch cut before the period closed', () => {
    const r = validateBatch({ ...batch, cutOn: day(2025, 5, 20) });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('batch_cut_before_period_end');
    }
  });

  it('refuses the same advocate twice', () => {
    const r = validateBatch({ ...batch, lines: [line, line] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('batch_advocate_twice');
    }
  });

  it('refuses a held line that carries an amount', () => {
    const bad = { ...heldLine, payable: money('USD', 100) };
    const r = validateBatch({ ...batch, lines: [bad] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('batch_held_line_pays');
    }
  });
});
