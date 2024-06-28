/**
 * Terminal local time. Feeds arrive stamped in the local time of the terminal
 * that produced them, and the offset is not in the payload. We carry our own
 * rule table rather than leaning on the platform time zone database, because
 * the answer has to be the same on a dispatcher laptop and in a container that
 * was built without tzdata.
 */

import { MS_PER_DAY, type Instant, type Day, startOfDay } from './clock.js';
import { fail, ok, type Result } from './result.js';

export type ZoneId =
  | 'America/New_York'
  | 'America/Chicago'
  | 'America/Denver'
  | 'America/Phoenix'
  | 'America/Los_Angeles'
  | 'UTC';

interface ZoneRule {
  readonly standardOffsetMinutes: number;
  readonly observesDaylight: boolean;
}

const ZONES: Record<ZoneId, ZoneRule> = {
  'America/New_York': { standardOffsetMinutes: -300, observesDaylight: true },
  'America/Chicago': { standardOffsetMinutes: -360, observesDaylight: true },
  'America/Denver': { standardOffsetMinutes: -420, observesDaylight: true },
  'America/Phoenix': { standardOffsetMinutes: -420, observesDaylight: false },
  'America/Los_Angeles': { standardOffsetMinutes: -480, observesDaylight: true },
  UTC: { standardOffsetMinutes: 0, observesDaylight: false },
};

export const ZONE_IDS: readonly ZoneId[] = Object.keys(ZONES) as ZoneId[];

export function isZoneId(value: string): value is ZoneId {
  return Object.prototype.hasOwnProperty.call(ZONES, value);
}

export function parseZoneId(value: string): Result<ZoneId> {
  return isZoneId(value) ? ok(value) : fail('zone_unknown', `no rule table for zone "${value}"`);
}

/** The nth given weekday of a month, as a UTC midnight instant. Sunday is 0. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  const firstOfMonth = Date.UTC(year, month - 1, 1);
  const firstWeekday = new Date(firstOfMonth).getUTCDay();
  const shift = (weekday - firstWeekday + 7) % 7;
  return firstOfMonth + (shift + (nth - 1) * 7) * MS_PER_DAY;
}

/**
 * United States daylight saving as it has stood since 2007: forward at 02:00
 * local standard on the second Sunday in March, back at 02:00 local daylight on
 * the first Sunday in November.
 */
function daylightWindow(year: number, standardOffsetMinutes: number): [number, number] {
  const springLocalMidnight = nthWeekdayOfMonth(year, 3, 0, 2);
  const fallLocalMidnight = nthWeekdayOfMonth(year, 11, 0, 1);
  const standardOffsetMs = standardOffsetMinutes * 60_000;
  const start = springLocalMidnight + 2 * 3_600_000 - standardOffsetMs;
  const end = fallLocalMidnight + 2 * 3_600_000 - (standardOffsetMs + 3_600_000);
  return [start, end];
}

export function offsetMinutesAt(zone: ZoneId, instant: Instant): number {
  const rule = ZONES[zone];
  if (!rule.observesDaylight) {
    return rule.standardOffsetMinutes;
  }
  const year = new Date(instant).getUTCFullYear();
  const [start, end] = daylightWindow(year, rule.standardOffsetMinutes);
  return instant >= start && instant < end
    ? rule.standardOffsetMinutes + 60
    : rule.standardOffsetMinutes;
}

export function isDaylightAt(zone: ZoneId, instant: Instant): boolean {
  return offsetMinutesAt(zone, instant) !== ZONES[zone].standardOffsetMinutes;
}

/** The calendar day an instant falls on for a terminal in this zone. */
export function localDayOf(zone: ZoneId, instant: Instant): Day {
  const shifted = new Date(instant + offsetMinutesAt(zone, instant) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    dayOfMonth: shifted.getUTCDate(),
  };
}

/**
 * Read a wall clock reading from a terminal as an instant. Two hazards live
 * here: the hour that does not exist on the spring forward, and the hour that
 * happens twice on the fall back. We resolve the gap forwards and the overlap
 * to the first occurrence, and we say which one we hit.
 */
export interface ZonedReading {
  readonly instant: Instant;
  readonly gap: boolean;
  readonly overlap: boolean;
}

export function readLocalWallClock(
  zone: ZoneId,
  localDay: Day,
  hour: number,
  minute: number,
  second: number,
): Result<ZonedReading> {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return fail(
      'wall_clock_out_of_range',
      `clock reading ${hour}:${minute}:${second} is not a time`,
    );
  }
  const rule = ZONES[zone];
  const localMillis = startOfDay(localDay) + (hour * 3600 + minute * 60 + second) * 1000;
  const standardGuess = localMillis - rule.standardOffsetMinutes * 60_000;
  const daylightGuess = localMillis - (rule.standardOffsetMinutes + 60) * 60_000;
  if (!rule.observesDaylight) {
    return ok({ instant: standardGuess, gap: false, overlap: false });
  }
  const standardValid = offsetMinutesAt(zone, standardGuess) === rule.standardOffsetMinutes;
  const daylightValid = offsetMinutesAt(zone, daylightGuess) === rule.standardOffsetMinutes + 60;
  if (standardValid && daylightValid) {
    return ok({ instant: daylightGuess, gap: false, overlap: true });
  }
  if (daylightValid) {
    return ok({ instant: daylightGuess, gap: false, overlap: false });
  }
  if (standardValid) {
    return ok({ instant: standardGuess, gap: false, overlap: false });
  }
  return ok({ instant: daylightGuess, gap: true, overlap: false });
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = String(Math.trunc(abs / 60)).padStart(2, '0');
  const rest = String(abs % 60).padStart(2, '0');
  return `${sign}${hours}:${rest}`;
}
