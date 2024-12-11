import { describe, expect, it } from 'vitest';
import {
  MAX_PLAUSIBLE_DRIFT_MILLIS,
  driftAt,
  normalize,
  normalizedLocalDay,
  orderedHeartbeats,
  perfectClock,
  validateClock,
  type TerminalClock,
} from '../../src/ingest/normalize.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const MINUTE = 60_000;
const base = Date.UTC(2025, 2, 15, 12, 0, 0);

const clock: TerminalClock = {
  terminal: 'joliet-fuel-desk',
  zone: 'America/Chicago',
  heartbeats: [
    { terminalAt: base, receivedAt: base - 2 * MINUTE },
    { terminalAt: base + 100 * MINUTE, receivedAt: base + 100 * MINUTE - 6 * MINUTE },
  ],
};

describe('validateClock', () => {
  it('accepts a clock with heartbeats', () => {
    expect(unwrap(validateClock(clock)).terminal).toBe('joliet-fuel-desk');
  });

  it('refuses a clock with no heartbeats', () => {
    const r = validateClock({ ...clock, heartbeats: [] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('clock_no_heartbeats');
    }
  });

  it('refuses a drift nobody would believe', () => {
    const wild: TerminalClock = {
      ...clock,
      heartbeats: [{ terminalAt: base, receivedAt: base - MAX_PLAUSIBLE_DRIFT_MILLIS - 1 }],
    };
    const r = validateClock(wild);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('clock_drift_implausible');
    }
  });

  it('accepts a drift exactly at the limit', () => {
    const edge: TerminalClock = {
      ...clock,
      heartbeats: [{ terminalAt: base, receivedAt: base - MAX_PLAUSIBLE_DRIFT_MILLIS }],
    };
    expect(isErr(validateClock(edge))).toBe(false);
  });
});

describe('orderedHeartbeats', () => {
  it('sorts whatever order they arrived in', () => {
    const shuffled: TerminalClock = { ...clock, heartbeats: [...clock.heartbeats].reverse() };
    expect(orderedHeartbeats(shuffled)[0]!.terminalAt).toBe(base);
  });
});

describe('driftAt', () => {
  it('takes the first drift before the first heartbeat', () => {
    const result = unwrap(driftAt(clock, base - 10 * MINUTE));
    expect(result.driftMillis).toBe(2 * MINUTE);
    expect(result.interpolated).toBe(false);
    expect(result.at).toBe(base - 12 * MINUTE);
  });

  it('takes the last drift after the last heartbeat', () => {
    const result = unwrap(driftAt(clock, base + 200 * MINUTE));
    expect(result.driftMillis).toBe(6 * MINUTE);
    expect(result.interpolated).toBe(false);
  });

  it('interpolates between two heartbeats', () => {
    const result = unwrap(driftAt(clock, base + 50 * MINUTE));
    expect(result.driftMillis).toBe(4 * MINUTE);
    expect(result.interpolated).toBe(true);
    expect(result.at).toBe(base + 46 * MINUTE);
  });

  it('interpolates a quarter of the way along', () => {
    expect(unwrap(driftAt(clock, base + 25 * MINUTE)).driftMillis).toBe(3 * MINUTE);
  });

  it('lands on the heartbeat drift at the heartbeat itself', () => {
    expect(unwrap(driftAt(clock, base)).driftMillis).toBe(2 * MINUTE);
    expect(unwrap(driftAt(clock, base + 100 * MINUTE)).driftMillis).toBe(6 * MINUTE);
  });

  it('handles two heartbeats stamped at the same terminal time', () => {
    const doubled: TerminalClock = {
      ...clock,
      heartbeats: [
        { terminalAt: base, receivedAt: base - MINUTE },
        { terminalAt: base, receivedAt: base - 2 * MINUTE },
      ],
    };
    expect(isErr(driftAt(doubled, base))).toBe(false);
  });

  it('fails on a clock with no heartbeats', () => {
    expect(isErr(driftAt({ ...clock, heartbeats: [] }, base))).toBe(true);
  });

  it('corrects a terminal running slow by adding time back', () => {
    const slow: TerminalClock = {
      ...clock,
      heartbeats: [{ terminalAt: base, receivedAt: base + 5 * MINUTE }],
    };
    expect(unwrap(driftAt(slow, base)).at).toBe(base + 5 * MINUTE);
  });
});

describe('normalize', () => {
  it('validates before it corrects', () => {
    expect(isErr(normalize({ ...clock, heartbeats: [] }, base))).toBe(true);
  });

  it('gives the corrected instant', () => {
    expect(unwrap(normalize(clock, base)).at).toBe(base - 2 * MINUTE);
  });
});

describe('normalizedLocalDay', () => {
  it('can move a reading to the previous day', () => {
    const nearMidnight = Date.UTC(2025, 2, 16, 5, 0, 30);
    const fast: TerminalClock = {
      terminal: 'joliet-fuel-desk',
      zone: 'America/Chicago',
      heartbeats: [{ terminalAt: nearMidnight, receivedAt: nearMidnight - 4 * MINUTE }],
    };
    expect(unwrap(normalizedLocalDay(fast, nearMidnight))).toEqual(day(2025, 3, 15));
  });

  it('leaves a reading alone when the clock is right', () => {
    const nearMidnight = Date.UTC(2025, 2, 16, 5, 0, 30);
    const right = perfectClock('joliet-fuel-desk', 'America/Chicago', nearMidnight);
    expect(unwrap(normalizedLocalDay(right, nearMidnight))).toEqual(day(2025, 3, 16));
  });

  it('passes a clock failure through', () => {
    expect(isErr(normalizedLocalDay({ ...clock, heartbeats: [] }, base))).toBe(true);
  });
});

describe('perfectClock', () => {
  it('has no drift', () => {
    const right = perfectClock('desk', 'UTC', base);
    expect(unwrap(driftAt(right, base)).driftMillis).toBe(0);
  });
});
