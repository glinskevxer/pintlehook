import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  addDays,
  addMonths,
  compareDays,
  day,
  dayOf,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  endOfDay,
  equalsDay,
  formatDay,
  formatInstant,
  isAfter,
  isBefore,
  isWeekend,
  parseDay,
  parseInstant,
  startOfDay,
} from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

describe('day construction', () => {
  it('builds a valid day', () => {
    expect(day(2025, 2, 28)).toEqual({ year: 2025, month: 2, dayOfMonth: 28 });
  });

  it('refuses the thirtieth of February', () => {
    expect(() => day(2025, 2, 30)).toThrow(/not a calendar day/);
  });

  it('accepts the twenty ninth in a leap year', () => {
    expect(() => day(2024, 2, 29)).not.toThrow();
  });

  it('refuses the twenty ninth in a century that is not a leap year', () => {
    expect(() => day(1900, 2, 29)).toThrow();
    expect(() => day(2000, 2, 29)).not.toThrow();
  });
});

describe('daysInMonth', () => {
  it('knows the short months', () => {
    expect(daysInMonth(2025, 4)).toBe(30);
    expect(daysInMonth(2025, 12)).toBe(31);
  });

  it('throws outside the year', () => {
    expect(() => daysInMonth(2025, 13)).toThrow(/month out of range/);
  });
});

describe('day parsing and formatting', () => {
  it('round trips', () => {
    expect(formatDay(unwrap(parseDay('2025-03-09')))).toBe('2025-03-09');
  });

  it('rejects a bad shape', () => {
    expect(isErr(parseDay('9 March 2025'))).toBe(true);
  });

  it('rejects a day that does not exist', () => {
    const r = parseDay('2025-02-30');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('day_out_of_range');
    }
  });
});

describe('instant parsing', () => {
  it('reads a Z instant', () => {
    expect(unwrap(parseInstant('2025-01-02T03:04:05Z'))).toBe(Date.UTC(2025, 0, 2, 3, 4, 5));
  });

  it('applies a positive offset by subtracting it', () => {
    const withOffset = unwrap(parseInstant('2025-01-02T03:04:05+02:00'));
    expect(withOffset).toBe(Date.UTC(2025, 0, 2, 1, 4, 5));
  });

  it('applies a negative offset by adding it', () => {
    const withOffset = unwrap(parseInstant('2025-01-02T03:04:05-05:00'));
    expect(withOffset).toBe(Date.UTC(2025, 0, 2, 8, 4, 5));
  });

  it('reads fractional seconds', () => {
    expect(unwrap(parseInstant('2025-01-02T03:04:05.250Z')) % 1000).toBe(250);
  });

  it('rejects a twenty fifth hour', () => {
    expect(isErr(parseInstant('2025-01-02T25:00:00Z'))).toBe(true);
  });

  it('rejects a missing zone', () => {
    expect(isErr(parseInstant('2025-01-02T03:04:05'))).toBe(true);
  });

  it('formats without the millisecond part', () => {
    expect(formatInstant(Date.UTC(2025, 0, 2, 3, 4, 5))).toBe('2025-01-02T03:04:05Z');
  });
});

describe('day and instant boundaries', () => {
  it('takes the day of an instant in UTC', () => {
    expect(dayOf(Date.UTC(2025, 5, 30, 23, 59, 59))).toEqual(day(2025, 6, 30));
  });

  it('starts and ends a day', () => {
    const d = day(2025, 6, 30);
    expect(endOfDay(d) - startOfDay(d)).toBe(MS_PER_DAY - 1);
  });
});

describe('day arithmetic', () => {
  it('adds across a month boundary', () => {
    expect(addDays(day(2025, 1, 30), 3)).toEqual(day(2025, 2, 2));
  });

  it('subtracts across a year boundary', () => {
    expect(addDays(day(2025, 1, 2), -3)).toEqual(day(2024, 12, 30));
  });

  it('counts days between', () => {
    expect(daysBetween(day(2025, 1, 1), day(2025, 3, 1))).toBe(59);
    expect(daysBetween(day(2024, 1, 1), day(2024, 3, 1))).toBe(60);
  });

  it('counts backwards as a negative', () => {
    expect(daysBetween(day(2025, 3, 1), day(2025, 1, 1))).toBe(-59);
  });

  it('adds months and clamps the day of month', () => {
    expect(addMonths(day(2025, 1, 31), 1)).toEqual(day(2025, 2, 28));
    expect(addMonths(day(2025, 3, 15), -4)).toEqual(day(2024, 11, 15));
  });
});

describe('ordering', () => {
  it('compares', () => {
    expect(compareDays(day(2025, 1, 1), day(2025, 1, 2))).toBeLessThan(0);
    expect(isBefore(day(2025, 1, 1), day(2025, 1, 2))).toBe(true);
    expect(isAfter(day(2025, 1, 3), day(2025, 1, 2))).toBe(true);
    expect(equalsDay(day(2025, 1, 2), day(2025, 1, 2))).toBe(true);
  });
});

describe('weekdays', () => {
  it('numbers Monday as one and Sunday as seven', () => {
    expect(dayOfWeek(day(2025, 3, 10))).toBe(1);
    expect(dayOfWeek(day(2025, 3, 16))).toBe(7);
  });

  it('reports the weekend', () => {
    expect(isWeekend(day(2025, 3, 15))).toBe(true);
    expect(isWeekend(day(2025, 3, 14))).toBe(false);
  });
});
