/**
 * The rules that decide what other rules measure.
 *
 * Each case here changes one rule and reads a number three or four layers away
 * that the changed rule never mentions. If any of these stop moving, a rule has
 * quietly become independent of the ones it is supposed to feed, and the
 * program has become a set of clauses rather than a scheme.
 */

import { describe, expect, it } from 'vitest';
import { resolveActivation } from '../../src/domain/activation.js';
import { carrierId, programId } from '../../src/domain/identity.js';
import { attributeReferral } from '../../src/service/attributionService.js';
import { positionOf, runCycle, type CycleRequest } from '../../src/service/cycle.js';
import { cutBatch, lineFor } from '../../src/service/settlementService.js';
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

describe('the cure window decides the attribution window', () => {
  const approval = {
    kind: 'conditional' as const,
    approvedOn: day(2025, 2, 10),
    insuranceClearedOn: day(2025, 3, 2),
  };

  it('backdates the activation under a wide cure window', () => {
    expect(unwrap(resolveActivation(approval, 21, day(2025, 6, 1))).basis).toBe('cured_in_window');
  });

  it('loses the backdating under a narrow one', () => {
    const wide = unwrap(resolveActivation(approval, 21, day(2025, 6, 1)));
    const narrow = unwrap(resolveActivation(approval, 20, day(2025, 6, 1)));
    expect(wide.basis).not.toBe(narrow.basis);
  });

  it('moves whether anybody is credited, which the cure rule never mentions', () => {
    const scenario = new Scenario(AT)
      .file(1, 'Brannan Hauling')
      .file(2, 'Cobb Transport')
      .file(9, 'Delacroix Transport')
      .enrol(1, day(2025, 1, 1))
      .enrol(2, day(2025, 1, 1))
      .touch(1, 9, Date.UTC(2024, 11, 20, 15))
      .touch(2, 9, Date.UTC(2025, 1, 20, 15));

    const wide = unwrap(
      attributeReferral(scenario.context, catalogWith(), {
        program: programId(1),
        invitee: carrierId(9),
        effectiveActivation: day(2025, 2, 10),
      }),
    );
    const narrow = unwrap(
      attributeReferral(scenario.context, catalogWith({ attributionWindowDays: 5 }), {
        program: programId(1),
        invitee: carrierId(9),
        effectiveActivation: day(2025, 2, 10),
      }),
    );
    expect(wide.credited).toBe(true);
    expect(narrow.credited).toBe(false);
  });
});

describe('attribution decides the tier, and the tier decides what everybody is paid', () => {
  function twoInvitees(sameAdvocate: boolean): Scenario {
    const scenario = new Scenario(AT)
      .file(1, 'Brannan Hauling')
      .file(2, 'Cobb Transport')
      .file(9, 'Delacroix Transport')
      .file(8, 'Ferriday Freight')
      .enrol(1, day(2025, 1, 1))
      .enrol(2, day(2025, 1, 1))
      .touch(1, 9, Date.UTC(2025, 0, 20, 15))
      .touch(sameAdvocate ? 1 : 2, 8, Date.UTC(2025, 0, 21, 15))
      .attribute(9, 1, day(2025, 2, 1))
      .attribute(8, sameAdvocate ? 1 : 2, day(2025, 2, 1));
    for (const invitee of [9, 8]) {
      scenario
        .load(invitee, day(2025, 2, 10))
        .load(invitee, day(2025, 3, 10))
        .load(invitee, day(2025, 5, 10))
        .load(invitee, day(2025, 7, 10));
    }
    return scenario;
  }

  it('pays more in total when both referrals land on one advocate', () => {
    const together = twoInvitees(true);
    unwrap(runCycle(together.context, catalogWith(), request, PROGRAM_YEAR));
    const onOne = positionOf(together.context, together.advocateOf(1), 'USD').minor;

    const split = twoInvitees(false);
    unwrap(runCycle(split.context, catalogWith(), request, PROGRAM_YEAR));
    const first = positionOf(split.context, split.advocateOf(1), 'USD').minor;
    const second = positionOf(split.context, split.advocateOf(2), 'USD').minor;

    expect(onOne).toBeGreaterThan(first + second);
  });

  it('pays each of two split referrals only the bronze rate', () => {
    const split = twoInvitees(false);
    unwrap(runCycle(split.context, catalogWith(), request, PROGRAM_YEAR));
    expect(positionOf(split.context, split.advocateOf(1), 'USD').minor).toBe(25_000);
    expect(positionOf(split.context, split.advocateOf(2), 'USD').minor).toBe(25_000);
  });

  it('moves the total when the qualifying count changes, three rules away', () => {
    const loose = twoInvitees(true);
    unwrap(runCycle(loose.context, catalogWith({ qualifyingLoadCount: 2 }), request, PROGRAM_YEAR));
    const tight = twoInvitees(true);
    unwrap(runCycle(tight.context, catalogWith({ qualifyingLoadCount: 9 }), request, PROGRAM_YEAR));
    expect(positionOf(loose.context, loose.advocateOf(1), 'USD').minor).toBeGreaterThan(
      positionOf(tight.context, tight.advocateOf(1), 'USD').minor,
    );
  });
});

describe('a posting three layers up moves the held batch count', () => {
  function base(): Scenario {
    return new Scenario(AT)
      .file(1, 'Brannan Hauling')
      .file(9, 'Delacroix Transport')
      .file(8, 'Ferriday Freight')
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

  it('holds nothing while both referrals stand', () => {
    const scenario = base();
    const report = unwrap(runCycle(scenario.context, catalogWith(), request, PROGRAM_YEAR));
    expect(report.settlement.heldCount).toBe(0);
    expect(lineFor(report.settlement.batch, scenario.advocateOf(1))!.payable.minor).toBeGreaterThan(
      0,
    );
  });

  it('holds the line once the position goes negative, and the hold rules never mention why', () => {
    const scenario = base();
    unwrap(runCycle(scenario.context, catalogWith(), request, PROGRAM_YEAR));
    const paid = positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor;
    scenario.writeRecord('accrual_posted', 'acr_recovery', {
      accrual: 'acr_recovery',
      advocate: scenario.advocateOf(1),
      program: programId(1),
      referralKey: `${programId(1)}:${carrierId(9)}`,
      kind: 'recovery',
      postedOn: '2025-11-15',
      programYearFrom: '2025-01-01',
      amountMinor: -paid - 1_000,
      currency: 'USD',
      reverses: '',
      note: 'recovered against a later settlement',
    });
    const plan = unwrap(
      cutBatch(scenario.context, catalogWith(), {
        program: programId(1),
        period: request.period,
        cutOn: request.cutOn,
        currency: 'USD',
      }),
    );
    expect(plan.heldCount).toBe(1);
    const line = lineFor(plan.batch, scenario.advocateOf(1));
    expect(line!.hold.reasons).toContain('negative_position');
    expect(line!.payable.minor).toBe(0);
  });

  it('reconciles an out of band posting away on the next accrual pass', () => {
    const scenario = base();
    unwrap(runCycle(scenario.context, catalogWith(), request, PROGRAM_YEAR));
    const paid = positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor;
    scenario.writeRecord('accrual_posted', 'acr_by_hand', {
      accrual: 'acr_by_hand',
      advocate: scenario.advocateOf(1),
      program: programId(1),
      referralKey: `${programId(1)}:${carrierId(9)}`,
      kind: 'adjustment',
      postedOn: '2025-11-15',
      programYearFrom: '2025-01-01',
      amountMinor: -9_900,
      currency: 'USD',
      reverses: '',
      note: 'somebody adjusted this by hand',
    });
    expect(positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor).toBe(paid - 9_900);
    unwrap(runCycle(scenario.context, catalogWith(), request, PROGRAM_YEAR));
    expect(positionOf(scenario.context, scenario.advocateOf(1), 'USD').minor).toBe(paid);
  });
});
