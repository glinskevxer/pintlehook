import { describe, expect, it } from 'vitest';
import { carrierId, loadId } from '../../src/domain/identity.js';
import type { Load } from '../../src/domain/load.js';
import {
  assessRetention,
  describeRetention,
  isAtRisk,
  retentionWindow,
  type RetentionInput,
} from '../../src/domain/retention.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const qualifiedOn = day(2025, 1, 6);

function delivered(sequence: number, on: ReturnType<typeof day>): Load {
  return {
    id: loadId(sequence),
    carrier: carrierId(9),
    status: 'delivered',
    deliveredOn: on,
    billedOn: undefined,
    lane: { originState: 'IL', destinationState: 'TX' },
    lineHaulMinor: 250_000,
    carrierPayMinor: 200_000,
    currency: 'USD',
    proNumber: `PL-${sequence}`,
  };
}

function run(overrides: Partial<RetentionInput> = {}) {
  return unwrap(
    assessRetention({
      loads: [],
      qualifiedOn,
      retentionDays: 180,
      checkpointDays: 60,
      asOf: day(2025, 8, 1),
      ...overrides,
    }),
  );
}

describe('retentionWindow', () => {
  it('starts on the qualifying day', () => {
    const window = unwrap(retentionWindow(qualifiedOn, 180));
    expect(window.from).toEqual(qualifiedOn);
    expect(window.until).toEqual(day(2025, 7, 5));
  });

  it('refuses a window of no days', () => {
    expect(isErr(retentionWindow(qualifiedOn, 0))).toBe(true);
  });
});

describe('checkpoints', () => {
  it('cuts the window into equal periods', () => {
    const assessment = run();
    expect(assessment.checkpoints).toHaveLength(3);
    expect(assessment.checkpoints[0]!.period.from).toEqual(qualifiedOn);
    expect(assessment.checkpoints[2]!.period.until).toEqual(day(2025, 7, 5));
  });

  it('counts deliveries into the checkpoint that owns the day', () => {
    const assessment = run({
      loads: [delivered(1, day(2025, 1, 20)), delivered(2, day(2025, 4, 1))],
    });
    expect(assessment.checkpoints[0]!.deliveries).toBe(1);
    expect(assessment.checkpoints[1]!.deliveries).toBe(1);
    expect(assessment.checkpoints[2]!.deliveries).toBe(0);
  });

  it('marks a checkpoint closed only once the day has passed', () => {
    const early = run({ asOf: day(2025, 3, 1) });
    expect(early.checkpoints[0]!.closed).toBe(false);
    const later = run({ asOf: day(2025, 3, 20) });
    expect(later.checkpoints[0]!.closed).toBe(true);
    expect(later.checkpoints[1]!.closed).toBe(false);
  });

  it('refuses a checkpoint of no days', () => {
    expect(
      isErr(
        assessRetention({
          loads: [],
          qualifiedOn,
          retentionDays: 180,
          checkpointDays: 0,
          asOf: day(2025, 8, 1),
        }),
      ),
    ).toBe(true);
  });
});

describe('holding', () => {
  it('holds while the window is open and every closed checkpoint has a load', () => {
    const assessment = run({
      loads: [delivered(1, day(2025, 1, 20)), delivered(2, day(2025, 3, 20))],
      asOf: day(2025, 4, 1),
    });
    expect(assessment.state).toBe('holding');
    expect(isAtRisk(assessment)).toBe(true);
  });

  it('records the last delivery it saw', () => {
    const assessment = run({
      loads: [delivered(1, day(2025, 1, 20)), delivered(2, day(2025, 3, 20))],
      asOf: day(2025, 4, 1),
    });
    expect(assessment.lastDeliveryOn).toEqual(day(2025, 3, 20));
  });
});

describe('satisfied', () => {
  it('satisfies once the window closes with every checkpoint covered', () => {
    const assessment = run({
      loads: [
        delivered(1, day(2025, 1, 20)),
        delivered(2, day(2025, 4, 1)),
        delivered(3, day(2025, 6, 1)),
      ],
    });
    expect(assessment.state).toBe('satisfied');
    expect(isAtRisk(assessment)).toBe(false);
  });

  it('does not satisfy on the day before the window closes', () => {
    const assessment = run({
      loads: [
        delivered(1, day(2025, 1, 20)),
        delivered(2, day(2025, 4, 1)),
        delivered(3, day(2025, 6, 1)),
      ],
      asOf: day(2025, 7, 4),
    });
    expect(assessment.state).toBe('holding');
  });
});

describe('failure on an empty checkpoint', () => {
  it('fails when a closed checkpoint carried nothing', () => {
    const assessment = run({
      loads: [delivered(1, day(2025, 1, 20)), delivered(2, day(2025, 6, 1))],
    });
    expect(assessment.state).toBe('failed');
    expect(assessment.firstEmptyClosedCheckpoint!.from).toEqual(day(2025, 3, 7));
  });

  it('dates the failure to the last day of the empty checkpoint', () => {
    const assessment = run({
      loads: [delivered(1, day(2025, 1, 20)), delivered(2, day(2025, 6, 1))],
    });
    expect(assessment.failedOn).toEqual(day(2025, 5, 5));
  });

  it('does not fail on an empty checkpoint that has not closed yet', () => {
    const assessment = run({
      loads: [delivered(1, day(2025, 1, 20))],
      asOf: day(2025, 3, 20),
    });
    expect(assessment.state).toBe('holding');
  });

  it('three loads in the first week is not retention', () => {
    const assessment = run({
      loads: [
        delivered(1, day(2025, 1, 7)),
        delivered(2, day(2025, 1, 8)),
        delivered(3, day(2025, 1, 9)),
      ],
    });
    expect(assessment.state).toBe('failed');
  });
});

describe('failure on lost authority', () => {
  it('fails whatever the deliveries say', () => {
    const assessment = run({
      loads: [
        delivered(1, day(2025, 1, 20)),
        delivered(2, day(2025, 4, 1)),
        delivered(3, day(2025, 6, 1)),
      ],
      authorityLostOn: day(2025, 5, 15),
    });
    expect(assessment.state).toBe('failed');
    expect(assessment.failedOn).toEqual(day(2025, 5, 15));
    expect(assessment.firstEmptyClosedCheckpoint).toBeUndefined();
  });

  it('ignores authority lost after the window closed', () => {
    const assessment = run({
      loads: [
        delivered(1, day(2025, 1, 20)),
        delivered(2, day(2025, 4, 1)),
        delivered(3, day(2025, 6, 1)),
      ],
      authorityLostOn: day(2025, 7, 5),
    });
    expect(assessment.state).toBe('satisfied');
  });
});

describe('describeRetention', () => {
  it('says which way it failed', () => {
    const emptyCheckpoint = run({ loads: [delivered(1, day(2025, 1, 20))] });
    expect(describeRetention(emptyCheckpoint)).toContain('empty checkpoint');
    const lostAuthority = run({ authorityLostOn: day(2025, 2, 1) });
    expect(describeRetention(lostAuthority)).toContain('lost authority');
  });

  it('says how many checkpoints are still running', () => {
    expect(
      describeRetention(run({ loads: [delivered(1, day(2025, 1, 20))], asOf: day(2025, 2, 1) })),
    ).toContain('3 checkpoints');
  });
});
