import { describe, expect, it } from 'vitest';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';
import {
  ZONE_IDS,
  formatOffset,
  isDaylightAt,
  isZoneId,
  localDayOf,
  offsetMinutesAt,
  parseZoneId,
  readLocalWallClock,
} from '../../src/util/zoned.js';

const JANUARY = Date.UTC(2025, 0, 15, 18, 0, 0);
const JULY = Date.UTC(2025, 6, 15, 18, 0, 0);

describe('zone table', () => {
  it('lists every zone it can answer for', () => {
    expect(ZONE_IDS).toContain('America/Chicago');
    expect(ZONE_IDS.length).toBeGreaterThan(4);
  });

  it('recognises and rejects zone names', () => {
    expect(isZoneId('America/Denver')).toBe(true);
    expect(isZoneId('Europe/Riga')).toBe(false);
    expect(isErr(parseZoneId('Europe/Riga'))).toBe(true);
    expect(unwrap(parseZoneId('UTC'))).toBe('UTC');
  });
});

describe('offsets', () => {
  it('uses standard time in January', () => {
    expect(offsetMinutesAt('America/New_York', JANUARY)).toBe(-300);
    expect(offsetMinutesAt('America/Chicago', JANUARY)).toBe(-360);
  });

  it('uses daylight time in July', () => {
    expect(offsetMinutesAt('America/New_York', JULY)).toBe(-240);
    expect(offsetMinutesAt('America/Los_Angeles', JULY)).toBe(-420);
  });

  it('leaves Phoenix alone all year', () => {
    expect(offsetMinutesAt('America/Phoenix', JANUARY)).toBe(-420);
    expect(offsetMinutesAt('America/Phoenix', JULY)).toBe(-420);
    expect(isDaylightAt('America/Phoenix', JULY)).toBe(false);
  });

  it('leaves UTC alone all year', () => {
    expect(offsetMinutesAt('UTC', JULY)).toBe(0);
  });

  it('reports whether daylight is in force', () => {
    expect(isDaylightAt('America/Denver', JULY)).toBe(true);
    expect(isDaylightAt('America/Denver', JANUARY)).toBe(false);
  });
});

describe('transition boundaries', () => {
  it('switches forward at two in the morning on the second Sunday in March', () => {
    const beforeSwitch = Date.UTC(2025, 2, 9, 6, 59, 0);
    const afterSwitch = Date.UTC(2025, 2, 9, 7, 1, 0);
    expect(offsetMinutesAt('America/New_York', beforeSwitch)).toBe(-300);
    expect(offsetMinutesAt('America/New_York', afterSwitch)).toBe(-240);
  });

  it('switches back on the first Sunday in November', () => {
    const beforeSwitch = Date.UTC(2025, 10, 2, 5, 59, 0);
    const afterSwitch = Date.UTC(2025, 10, 2, 6, 1, 0);
    expect(offsetMinutesAt('America/New_York', beforeSwitch)).toBe(-240);
    expect(offsetMinutesAt('America/New_York', afterSwitch)).toBe(-300);
  });

  it('finds a different second Sunday in a different year', () => {
    const early2026 = Date.UTC(2026, 2, 8, 8, 0, 0);
    expect(offsetMinutesAt('America/Chicago', early2026)).toBe(-300);
  });
});

describe('localDayOf', () => {
  it('rolls back a day for an evening instant on the east coast', () => {
    expect(localDayOf('America/New_York', Date.UTC(2025, 0, 16, 2, 30, 0))).toEqual(
      day(2025, 1, 15),
    );
  });

  it('agrees with UTC for the UTC zone', () => {
    expect(localDayOf('UTC', Date.UTC(2025, 0, 16, 2, 30, 0))).toEqual(day(2025, 1, 16));
  });
});

describe('readLocalWallClock', () => {
  it('reads an ordinary standard time reading', () => {
    const r = unwrap(readLocalWallClock('America/Chicago', day(2025, 1, 15), 9, 30, 0));
    expect(r.instant).toBe(Date.UTC(2025, 0, 15, 15, 30, 0));
    expect(r.gap).toBe(false);
    expect(r.overlap).toBe(false);
  });

  it('reads an ordinary daylight time reading', () => {
    const r = unwrap(readLocalWallClock('America/Chicago', day(2025, 7, 15), 9, 30, 0));
    expect(r.instant).toBe(Date.UTC(2025, 6, 15, 14, 30, 0));
  });

  it('flags the hour that does not exist on the spring forward', () => {
    const r = unwrap(readLocalWallClock('America/New_York', day(2025, 3, 9), 2, 30, 0));
    expect(r.gap).toBe(true);
    expect(r.overlap).toBe(false);
  });

  it('flags the hour that happens twice on the fall back and takes the first', () => {
    const r = unwrap(readLocalWallClock('America/New_York', day(2025, 11, 2), 1, 30, 0));
    expect(r.overlap).toBe(true);
    expect(r.instant).toBe(Date.UTC(2025, 10, 2, 5, 30, 0));
  });

  it('has no gap or overlap in a zone without daylight saving', () => {
    const r = unwrap(readLocalWallClock('America/Phoenix', day(2025, 3, 9), 2, 30, 0));
    expect(r.gap).toBe(false);
    expect(r.overlap).toBe(false);
  });

  it('rejects a reading that is not a time', () => {
    expect(isErr(readLocalWallClock('UTC', day(2025, 1, 1), 24, 0, 0))).toBe(true);
    expect(isErr(readLocalWallClock('UTC', day(2025, 1, 1), 1, 60, 0))).toBe(true);
  });
});

describe('formatOffset', () => {
  it('formats both signs and a half hour', () => {
    expect(formatOffset(-300)).toBe('-05:00');
    expect(formatOffset(330)).toBe('+05:30');
    expect(formatOffset(0)).toBe('+00:00');
  });
});
