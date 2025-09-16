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

const request: CycleRequest = {
  program: programId(1),
  period: interval(day(2025, 11, 1), day(2025, 12, 1)),
  cutOn: day(2025, 12, 2),
  currency: 'USD',
  programYearFrom: day(2025, 1, 1),
};

/** One advocate, one invited carrier that keeps hauling, through to a cheque. */
function oneGoodReferral(): Scenario {
  return new Scenario(AT)
    .file(1, 'Brannan Hauling')
    .file(9, 'Delacroix Transport')
    .enrol(1, day(2025, 1, 1))
    .touch(1, 9, Date.UTC(2025, 0, 20, 15))
    .attribute(9, 1, day(2025, 2, 1))
    .load(9, day(2025, 2, 10))
    .load(9, day(2025, 3, 10))
    .load(9, day(2025, 5, 10))
    .load(9, day(2025, 7, 10));
}

describe('a referral that goes all the way through', () => {
  const scenario = oneGoodReferral();
  const catalog = catalogWith();
  const report = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  it('qualifies once and claws back nothing', () => {
    expect(report.qualified).toBe(1);
    expect(report.clawedBack).toBe(0);
  });

  it('pays the bronze bounty on the settlement line', () => {
    const line = lineFor(report.settlement.batch, scenario.advocateOf(1));
    expect(line!.hold.held).toBe(false);
    expect(line!.payable.minor).toBe(25_000);
  });

  it('leaves the advocate position matching what was paid', () => {
    expect(positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor).toBe(25_000);
  });

  it('shows one posting on the statement with a reason', () => {
    const statement = unwrap(buildStatement(scenario.context, scenario.advocateOf(1), 'USD'));
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]!.note).toContain('first posting');
    expect(statement.closingBalance.minor).toBe(25_000);
  });

  it('reconciles the ladder against the accrual table', () => {
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

  it('leaves the store passing every integrity check', () => {
    expect(runIntegrity(scenario.store).clean).toBe(true);
  });

  it('leaves the journal verifying', () => {
    expect(unwrap(scenario.store.journal.verify())).toBe(scenario.store.sequence);
  });
});

describe('a second referral arriving after the first was already paid', () => {
  const scenario = oneGoodReferral();
  const catalog = catalogWith();
  const first = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  scenario
    .file(8, 'Cobb Transport')
    .touch(1, 8, Date.UTC(2025, 2, 20, 15))
    .attribute(8, 1, day(2025, 4, 1))
    .load(8, day(2025, 4, 10))
    .load(8, day(2025, 5, 10))
    .load(8, day(2025, 7, 10))
    .load(8, day(2025, 9, 10));

  const second = unwrap(runCycle(scenario.context, catalog, request, PROGRAM_YEAR));

  it('qualified one on the first run and one on the second', () => {
    expect(first.qualified).toBe(1);
    expect(second.qualified).toBe(1);
  });

  it('true ups the first referral when the second crosses the tier', () => {
    const statement = unwrap(buildStatement(scenario.context, scenario.advocateOf(1), 'USD'));
    expect(statement.lines.map((line) => line.kind)).toContain('true_up');
  });

  it('dates the true up to the crossing rather than to the first bounty', () => {
    const statement = unwrap(buildStatement(scenario.context, scenario.advocateOf(1), 'USD'));
    const trueUp = statement.lines.find((line) => line.kind === 'true_up');
    expect(trueUp).toBeDefined();
    expect(trueUp!.referralKey).toContain('cxr_00000009');
  });

  it('leaves both referrals worth the same in the end', () => {
    const statement = unwrap(buildStatement(scenario.context, scenario.advocateOf(1), 'USD'));
    const byReferral = new Map<string, number>();
    for (const line of statement.lines) {
      byReferral.set(line.referralKey, (byReferral.get(line.referralKey) ?? 0) + line.amount.minor);
    }
    const totals = [...byReferral.values()];
    expect(totals).toHaveLength(2);
    expect(new Set(totals).size).toBe(1);
  });

  it('pays the silver total on one settlement line', () => {
    const line = lineFor(second.settlement.batch, scenario.advocateOf(1));
    expect(line!.payable.minor).toBe(
      positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor,
    );
    expect(line!.payable.minor).toBeGreaterThan(50_000);
  });

  it('still reconciles after the true up', () => {
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
