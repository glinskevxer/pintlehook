import { describe, expect, it } from 'vitest';
import { programId } from '../../src/domain/identity.js';
import { positionOf, runCycle, type CycleRequest } from '../../src/service/cycle.js';
import { lineFor } from '../../src/service/settlementService.js';
import { buildStatement } from '../../src/report/statement.js';
import { reconcileProgram } from '../../src/service/reconciliation.js';
import { runIntegrity } from '../../src/storage/integrity.js';
import { day } from '../../src/util/clock.js';
import { interval } from '../../src/util/interval.js';
import { unwrap } from '../../src/util/result.js';
import { Scenario, catalogWith } from '../support/scenario.js';

const AT = Date.UTC(2025, 11, 2);
const PROGRAM_YEAR = interval(day(2025, 1, 1), day(2026, 1, 1));
const catalog = catalogWith();

const request: CycleRequest = {
  program: programId(1),
  period: interval(day(2025, 11, 1), day(2025, 12, 1)),
  cutOn: day(2025, 12, 2),
  currency: 'USD',
  programYearFrom: day(2025, 1, 1),
};

/** Two invited carriers, both qualified, so the advocate is on the silver rung. */
function twoQualified(): Scenario {
  return new Scenario(AT)
    .file(1, 'Brannan Hauling')
    .file(9, 'Delacroix Transport')
    .file(8, 'Cobb Transport')
    .enrol(1, day(2025, 1, 1))
    .touch(1, 9, Date.UTC(2025, 0, 20, 15))
    .touch(1, 8, Date.UTC(2025, 0, 21, 15))
    .attribute(9, 1, day(2025, 2, 1))
    .attribute(8, 1, day(2025, 2, 1))
    .load(9, day(2025, 2, 10))
    .load(9, day(2025, 3, 10))
    .load(9, day(2025, 5, 10))
    .load(9, day(2025, 7, 10))
    .load(8, day(2025, 2, 12))
    .load(8, day(2025, 3, 12))
    .load(8, day(2025, 5, 12))
    .load(8, day(2025, 7, 12));
}

describe('a carrier that stops hauling', () => {
  const scenario = new Scenario(AT)
    .file(1, 'Brannan Hauling')
    .file(9, 'Delacroix Transport')
    .enrol(1, day(2025, 1, 1))
    .touch(1, 9, Date.UTC(2025, 0, 20, 15))
    .attribute(9, 1, day(2025, 2, 1))
    .load(9, day(2025, 2, 10))
    .load(9, day(2025, 2, 11));
  const report = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  it('qualifies and then claws the same referral back in one cycle', () => {
    expect(report.qualified).toBe(1);
    expect(report.clawedBack).toBe(1);
  });

  it('leaves the advocate at nothing', () => {
    expect(positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor).toBe(0);
  });

  it('shows both sides on the statement rather than one smaller total', () => {
    const statement = unwrap(buildStatement(scenario.context, scenario.advocateOf(1), 'USD'));
    expect(statement.lines.length).toBeGreaterThan(1);
    expect(statement.lines.some((line) => line.amount.minor < 0)).toBe(true);
    expect(statement.closingBalance.minor).toBe(0);
  });

  it('reconciles at zero', () => {
    const reconciliation = unwrap(
      reconcileProgram(
        scenario.context,
        catalog,
        programId(1),
        PROGRAM_YEAR,
        day(2025, 1, 1),
        'USD',
      ),
    );
    expect(reconciliation.disagreements).toBe(0);
  });
});

describe('a clawback dropping the advocate a tier', () => {
  const scenario = twoQualified();
  const before = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));
  const paidAtSilver = positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor;

  scenario.claim(1, day(2025, 4, 1), 400_000);
  const after = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  it('qualified two before the claim landed', () => {
    expect(before.qualified).toBe(2);
    expect(paidAtSilver).toBeGreaterThan(50_000);
  });

  it('claws one back once the claim eats past the tolerance', () => {
    expect(after.clawedBack).toBe(1);
  });

  it('takes the surviving referral back down to the bronze rate', () => {
    expect(positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor).toBe(25_000);
  });

  it('posts the true down as its own line with a reason', () => {
    const statement = unwrap(buildStatement(scenario.context, scenario.advocateOf(1), 'USD'));
    const down = statement.lines.find((line) => line.kind === 'true_down');
    expect(down).toBeDefined();
    expect(down!.note).toContain('tier fell back');
  });

  it('still reconciles after the tier fell', () => {
    const reconciliation = unwrap(
      reconcileProgram(
        scenario.context,
        catalog,
        programId(1),
        PROGRAM_YEAR,
        day(2025, 1, 1),
        'USD',
      ),
    );
    expect(reconciliation.disagreements).toBe(0);
  });

  it('leaves the store intact', () => {
    expect(runIntegrity(scenario.store).clean).toBe(true);
  });
});

describe('a clawback that takes the advocate negative', () => {
  const scenario = twoQualified();
  unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  scenario.claim(1, day(2025, 4, 1), 400_000).claim(5, day(2025, 4, 2), 400_000);
  const after = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  it('claws both back', () => {
    expect(after.clawedBack).toBe(2);
  });

  it('leaves nothing owed', () => {
    expect(positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor).toBe(0);
  });

  it('cuts a batch with nothing to pay on that line', () => {
    const line = lineFor(after.settlement.batch, scenario.advocateOf(1));
    expect(line === undefined || line.payable.minor === 0).toBe(true);
  });
});

describe('an absorbed claim', () => {
  const scenario = twoQualified();
  unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));
  const before = positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor;

  scenario.claim(1, day(2025, 4, 1), 900_000, 'absorbed');
  const after = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  it('claws nothing back however large it is', () => {
    expect(after.clawedBack).toBe(0);
  });

  it('leaves the position where it was', () => {
    expect(positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor).toBe(before);
  });
});
