import { describe, expect, it } from 'vitest';
import { carrierId, loadId } from '../../src/domain/identity.js';
import type { Load } from '../../src/domain/load.js';
import {
  countsTowardsQualification,
  describeQualification,
  qualifyingMargin,
  qualifyingWindow,
  resolveQualification,
} from '../../src/domain/qualification.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const activation = day(2025, 3, 1);

function delivered(sequence: number, on: ReturnType<typeof day>, marginMinor = 50_000): Load {
  return {
    id: loadId(sequence),
    carrier: carrierId(9),
    status: 'delivered',
    deliveredOn: on,
    billedOn: undefined,
    lane: { originState: 'IL', destinationState: 'TX' },
    lineHaulMinor: 200_000 + marginMinor,
    carrierPayMinor: 200_000,
    currency: 'USD',
    proNumber: `PL-${String(sequence).padStart(6, '0')}`,
  };
}

function run(loads: Load[], count = 3, windowDays = 120) {
  return unwrap(
    resolveQualification({
      loads,
      effectiveActivation: activation,
      qualifyingLoadCount: count,
      qualifyingWindowDays: windowDays,
      currency: 'USD',
    }),
  );
}

describe('qualifyingWindow', () => {
  it('starts on the activation day', () => {
    const window = unwrap(qualifyingWindow(activation, 120));
    expect(window.from).toEqual(day(2025, 3, 1));
    expect(window.until).toEqual(day(2025, 6, 29));
  });

  it('refuses a window of no days', () => {
    expect(isErr(qualifyingWindow(activation, 0))).toBe(true);
  });
});

describe('countsTowardsQualification', () => {
  const window = unwrap(qualifyingWindow(activation, 120));

  it('counts a delivered load inside the window', () => {
    expect(countsTowardsQualification(delivered(1, day(2025, 4, 1)), window)).toBe(true);
  });

  it('does not count a load in transit', () => {
    const pending: Load = {
      ...delivered(1, day(2025, 4, 1)),
      status: 'in_transit',
      deliveredOn: undefined,
    };
    expect(countsTowardsQualification(pending, window)).toBe(false);
  });

  it('does not count a load delivered before activation', () => {
    expect(countsTowardsQualification(delivered(1, day(2025, 2, 28)), window)).toBe(false);
  });

  it('counts a load delivered on the activation day', () => {
    expect(countsTowardsQualification(delivered(1, day(2025, 3, 1)), window)).toBe(true);
  });

  it('does not count a load delivered on the day the window closes', () => {
    expect(countsTowardsQualification(delivered(1, day(2025, 6, 29)), window)).toBe(false);
  });
});

describe('resolveQualification', () => {
  it('qualifies on the nth delivered load', () => {
    const outcome = run([
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20)),
      delivered(3, day(2025, 4, 2)),
      delivered(4, day(2025, 4, 20)),
    ]);
    expect(outcome.qualified).toBe(true);
    if (outcome.qualified) {
      expect(outcome.qualifiedOn).toEqual(day(2025, 4, 2));
      expect(outcome.qualifyingLoad.id).toBe(loadId(3));
    }
  });

  it('counts every delivered load in the margin, not only the first three', () => {
    const outcome = run([
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20)),
      delivered(3, day(2025, 4, 2)),
      delivered(4, day(2025, 4, 20)),
    ]);
    expect(outcome.deliveredMargin.minor).toBe(200_000);
    expect(outcome.countingLoads).toHaveLength(4);
  });

  it('does not depend on the order the loads arrived in', () => {
    const loads = [
      delivered(3, day(2025, 4, 2)),
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20)),
    ];
    const outcome = run(loads);
    if (outcome.qualified) {
      expect(outcome.qualifiedOn).toEqual(day(2025, 4, 2));
    }
  });

  it('reports how short it is', () => {
    const outcome = run([delivered(1, day(2025, 3, 5))]);
    expect(outcome.qualified).toBe(false);
    expect(outcome.shortBy).toBe(2);
  });

  it('counts a load that lost money towards the number', () => {
    const outcome = run([
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20), -10_000),
      delivered(3, day(2025, 4, 2)),
    ]);
    expect(outcome.qualified).toBe(true);
    expect(outcome.deliveredMargin.minor).toBe(90_000);
  });

  it('does not qualify on loads outside the window', () => {
    const outcome = run([
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20)),
      delivered(3, day(2025, 8, 2)),
    ]);
    expect(outcome.qualified).toBe(false);
    expect(outcome.shortBy).toBe(1);
  });

  it('moves the qualifying day when the window narrows', () => {
    const loads = [
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20)),
      delivered(3, day(2025, 4, 2)),
      delivered(4, day(2025, 7, 2)),
    ];
    expect(run(loads, 4, 200).qualified).toBe(true);
    expect(run(loads, 4, 120).qualified).toBe(false);
  });

  it('refuses a qualifying count of zero', () => {
    const r = resolveQualification({
      loads: [],
      effectiveActivation: activation,
      qualifyingLoadCount: 0,
      qualifyingWindowDays: 120,
      currency: 'USD',
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('qualifying_count_invalid');
    }
  });

  it('refuses a load in another currency', () => {
    const foreign: Load = { ...delivered(1, day(2025, 3, 5)), currency: 'CAD' };
    const r = resolveQualification({
      loads: [foreign],
      effectiveActivation: activation,
      qualifyingLoadCount: 1,
      qualifyingWindowDays: 120,
      currency: 'USD',
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('qualifying_currency_mismatch');
    }
  });
});

describe('qualifyingMargin', () => {
  it('is the delivered margin once qualified', () => {
    const outcome = run([
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20)),
      delivered(3, day(2025, 4, 2)),
    ]);
    expect(qualifyingMargin(outcome, 'USD').minor).toBe(150_000);
  });

  it('is zero while the referral is short', () => {
    expect(qualifyingMargin(run([delivered(1, day(2025, 3, 5))]), 'USD').minor).toBe(0);
  });
});

describe('describeQualification', () => {
  it('names the load that qualified it', () => {
    const outcome = run([
      delivered(1, day(2025, 3, 5)),
      delivered(2, day(2025, 3, 20)),
      delivered(3, day(2025, 4, 2)),
    ]);
    expect(describeQualification(outcome)).toContain('PL-000003');
  });

  it('says how short it is', () => {
    expect(describeQualification(run([]))).toBe('short by 3 of the qualifying loads');
  });
});
