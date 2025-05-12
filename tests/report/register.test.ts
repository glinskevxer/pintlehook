import { describe, expect, it } from 'vitest';
import { advocateId, batchId, settlementId } from '../../src/domain/identity.js';
import type { HoldVerdict } from '../../src/domain/hold.js';
import {
  buildLine,
  type SettlementBatch,
  type SettlementLine,
} from '../../src/domain/settlement.js';
import {
  biggestLine,
  checkRegister,
  heldReport,
  payableReport,
  registerReport,
  summarize,
} from '../../src/report/register.js';
import { renderText } from '../../src/report/table.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { money } from '../../src/util/money.js';
import { unwrap } from '../../src/util/result.js';

const clear: HoldVerdict = { held: false, reasons: [], primaryReason: undefined };
const held: HoldVerdict = {
  held: true,
  reasons: ['negative_position', 'recovery_over_ceiling'],
  primaryReason: 'negative_position',
};

function line(seq: number, positionMinor: number, withheldMinor: number, hold = clear) {
  return unwrap(
    buildLine(
      settlementId(seq),
      advocateId(seq),
      [],
      money('USD', positionMinor),
      money('USD', withheldMinor),
      hold,
      'USD',
    ),
  );
}

function batchOf(lines: SettlementLine[]): SettlementBatch {
  return {
    id: batchId(1),
    period: interval(day(2025, 5, 1), day(2025, 6, 1)),
    cutOn: day(2025, 6, 2),
    state: 'cut',
    currency: 'USD',
    lines,
  };
}

describe('summarize', () => {
  it('adds the payable and the withheld', () => {
    const summary = summarize(batchOf([line(1, 50_000, 10_000), line(2, 30_000, 0)]));
    expect(summary.payable.minor).toBe(70_000);
    expect(summary.withheld.minor).toBe(10_000);
    expect(summary.gross.minor).toBe(80_000);
    expect(summary.adds).toBe(true);
  });

  it('leaves a held line out of the gross', () => {
    const summary = summarize(batchOf([line(1, 50_000, 0), line(2, -30_000, 0, held)]));
    expect(summary.held).toBe(1);
    expect(summary.gross.minor).toBe(50_000);
    expect(summary.adds).toBe(true);
  });

  it('counts every line whether held or not', () => {
    expect(summarize(batchOf([line(1, 1, 0), line(2, -1, 0, held)])).lines).toBe(2);
  });

  it('is empty for a batch with no lines', () => {
    const summary = summarize(batchOf([]));
    expect(summary.lines).toBe(0);
    expect(summary.payable.minor).toBe(0);
    expect(summary.adds).toBe(true);
  });
});

describe('registerReport', () => {
  const report = registerReport(batchOf([line(1, 50_000, 10_000), line(2, -30_000, 0, held)]));

  it('prints held lines as well as payable ones', () => {
    expect(report.rows).toHaveLength(2);
  });

  it('names the primary hold reason on a held line', () => {
    expect(renderText(report)).toContain('negative_position');
  });

  it('leaves the hold column blank on a clear line', () => {
    expect(report.columns.find((column) => column.key === 'hold')!.render(report.rows[0]!)).toBe(
      '',
    );
  });

  it('names the period in the title', () => {
    expect(report.title).toContain('2025-05-01');
    expect(report.title).toContain('2025-06-01');
  });

  it('footnotes that the columns add up', () => {
    expect(report.footnotes.join(' ')).toContain('equals gross');
  });

  it('warns when the paid and withheld columns do not meet the position', () => {
    const wrong = line(1, 50_000, 10_000);
    const broken: SettlementLine = { ...wrong, payable: money('USD', 1) };
    expect(registerReport(batchOf([broken])).footnotes.join(' ')).toContain('WARNING');
  });

  it('the check can come out either way on the same batch', () => {
    const good = line(1, 50_000, 10_000);
    const broken: SettlementLine = { ...good, payable: money('USD', 1) };
    expect(summarize(batchOf([good])).adds).toBe(true);
    expect(summarize(batchOf([broken])).adds).toBe(false);
  });
});

describe('heldReport', () => {
  it('lists only the held lines with every reason', () => {
    const report = heldReport(batchOf([line(1, 50_000, 0), line(2, -30_000, 0, held)]));
    expect(report.rows).toHaveLength(1);
    expect(renderText(report)).toContain('recovery_over_ceiling');
  });

  it('says how many of how many', () => {
    const report = heldReport(batchOf([line(1, 50_000, 0), line(2, -30_000, 0, held)]));
    expect(report.footnotes[0]).toBe('1 of 2 lines are held');
  });
});

describe('payableReport', () => {
  it('lists only the lines with something to pay', () => {
    const report = payableReport(
      batchOf([line(1, 50_000, 0), line(2, 0, 0), line(3, -30_000, 0, held)]),
    );
    expect(report.rows).toHaveLength(1);
    expect(report.footnotes[0]).toBe('1 lines to pay');
  });
});

describe('checkRegister', () => {
  it('gives back the summary', () => {
    expect(unwrap(checkRegister(batchOf([line(1, 50_000, 0)]))).payable.minor).toBe(50_000);
  });
});

describe('biggestLine', () => {
  it('finds the largest payable', () => {
    const found = biggestLine(batchOf([line(1, 10_000, 0), line(2, 90_000, 0)]));
    expect(found!.advocate).toBe(advocateId(2));
  });

  it('returns nothing for an empty batch', () => {
    expect(biggestLine(batchOf([]))).toBeUndefined();
  });

  it('treats a held line as paying nothing', () => {
    const found = biggestLine(batchOf([line(1, 10_000, 0), line(2, 900_000, 0, held)]));
    expect(found!.advocate).toBe(advocateId(1));
  });
});
