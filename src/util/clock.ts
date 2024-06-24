/**
 * Instants and calendar days. An instant is milliseconds since the epoch and is
 * always UTC. A day is a plain calendar date with no zone attached, which is
 * what a settlement period and a cure period are actually counted in.
 */

import { fail, ok, type Result } from './result.js';

export type Instant = number;

export interface Day {
  readonly year: number;
  readonly month: number;
  readonly dayOfMonth: number;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function day(year: number, month: number, dayOfMonth: number): Day {
  if (!isValidDay(year, month, dayOfMonth)) {
    throw new Error(`not a calendar day: ${year}-${month}-${dayOfMonth}`);
  }
  return { year, month, dayOfMonth };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const length = lengths[month - 1];
  if (length === undefined) {
    throw new Error(`month out of range: ${month}`);
  }
  return length;
}

function isValidDay(year: number, month: number, dayOfMonth: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(dayOfMonth)) {
    return false;
  }
  if (month < 1 || month > 12 || dayOfMonth < 1) {
    return false;
  }
  return dayOfMonth <= daysInMonth(year, month);
}

export function parseDay(text: string): Result<Day> {
  const match = DAY_PATTERN.exec(text.trim());
  if (match === null) {
    return fail('day_unparseable', `cannot read "${text}" as a calendar day`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  if (!isValidDay(year, month, dayOfMonth)) {
    return fail('day_out_of_range', `no such calendar day: ${text}`);
  }
  return ok({ year, month, dayOfMonth });
}

export function formatDay(value: Day): string {
  const month = String(value.month).padStart(2, '0');
  const dayOfMonth = String(value.dayOfMonth).padStart(2, '0');
  return `${value.year}-${month}-${dayOfMonth}`;
}

export function parseInstant(text: string): Result<Instant> {
  const match = INSTANT_PATTERN.exec(text.trim());
  if (match === null) {
    return fail('instant_unparseable', `cannot read "${text}" as an instant`);
  }
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const year = Number(y);
  const month = Number(mo);
  const dayOfMonth = Number(d);
  if (!isValidDay(year, month, dayOfMonth)) {
    return fail('instant_out_of_range', `no such calendar day in "${text}"`);
  }
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (hour > 23 || minute > 59 || second > 59) {
    return fail('instant_out_of_range', `clock field out of range in "${text}"`);
  }
  const millis = Number((frac ?? '').padEnd(3, '0') || '0');
  const base = Date.UTC(year, month - 1, dayOfMonth, hour, minute, second, millis);
  return ok(base - offsetMillis(offset ?? 'Z'));
}

function offsetMillis(offset: string): number {
  if (offset === 'Z') {
    return 0;
  }
  const sign = offset.startsWith('-') ? -1 : 1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return sign * (hours * MS_PER_HOUR + minutes * MS_PER_MINUTE);
}

export function formatInstant(value: Instant): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function dayOf(value: Instant): Day {
  const date = new Date(value);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    dayOfMonth: date.getUTCDate(),
  };
}

export function startOfDay(value: Day): Instant {
  return Date.UTC(value.year, value.month - 1, value.dayOfMonth);
}

export function endOfDay(value: Day): Instant {
  return startOfDay(value) + MS_PER_DAY - 1;
}

export function addDays(value: Day, count: number): Day {
  return dayOf(startOfDay(value) + count * MS_PER_DAY);
}

export function daysBetween(from: Day, to: Day): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / MS_PER_DAY);
}

export function compareDays(left: Day, right: Day): number {
  return startOfDay(left) - startOfDay(right);
}

export function isBefore(left: Day, right: Day): boolean {
  return compareDays(left, right) < 0;
}

export function isAfter(left: Day, right: Day): boolean {
  return compareDays(left, right) > 0;
}

export function equalsDay(left: Day, right: Day): boolean {
  return compareDays(left, right) === 0;
}

/** Day of week with Monday as 1 and Sunday as 7, which is how the office counts. */
export function dayOfWeek(value: Day): number {
  const jsDay = new Date(startOfDay(value)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

export function isWeekend(value: Day): boolean {
  return dayOfWeek(value) >= 6;
}

export function addMonths(value: Day, count: number): Day {
  const total = value.year * 12 + (value.month - 1) + count;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const clamped = Math.min(value.dayOfMonth, daysInMonth(year, month));
  return { year, month, dayOfMonth: clamped };
}
