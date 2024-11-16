/**
 * Reading fields out of a partner's row. Nobody agrees on how to spell a
 * boolean, a blank, a money amount or a date, and every one of these
 * disagreements has cost the desk a day at some point.
 *
 * A coercion never guesses silently. It either produces a value or a problem
 * naming the column, and the quarantine keeps the row so it can be looked at.
 */

import { parseDay, parseInstant, type Day, type Instant } from '../util/clock.js';
import { isCurrency, type Currency } from '../util/money.js';
import { fail, ok, type Result } from '../util/result.js';

export type Row = Readonly<Record<string, string>>;

const BLANKS = new Set(['', '-', 'n/a', 'na', 'null', 'none', 'nil', 'unknown']);
const TRUE_WORDS = new Set(['y', 'yes', 'true', 't', '1', 'on']);
const FALSE_WORDS = new Set(['n', 'no', 'false', 'f', '0', 'off']);

export function isBlank(raw: string | undefined): boolean {
  return raw === undefined || BLANKS.has(raw.trim().toLowerCase());
}

export function readText(row: Row, column: string): Result<string> {
  const raw = row[column];
  if (isBlank(raw)) {
    return fail('field_missing', `${column} is empty`, column);
  }
  return ok((raw as string).trim());
}

export function readOptionalText(row: Row, column: string): string | undefined {
  const raw = row[column];
  return isBlank(raw) ? undefined : (raw as string).trim();
}

export function readBoolean(row: Row, column: string): Result<boolean> {
  const raw = row[column];
  if (isBlank(raw)) {
    return fail('field_missing', `${column} is empty`, column);
  }
  const word = (raw as string).trim().toLowerCase();
  if (TRUE_WORDS.has(word)) {
    return ok(true);
  }
  if (FALSE_WORDS.has(word)) {
    return ok(false);
  }
  return fail('field_not_boolean', `${column} reads "${raw as string}"`, column);
}

export function readInteger(row: Row, column: string): Result<number> {
  const raw = row[column];
  if (isBlank(raw)) {
    return fail('field_missing', `${column} is empty`, column);
  }
  const cleaned = (raw as string).replace(/,/g, '').trim();
  if (!/^-?\d+$/.test(cleaned)) {
    return fail('field_not_integer', `${column} reads "${raw as string}"`, column);
  }
  return ok(Number(cleaned));
}

/**
 * Money arrives as dollars and cents with a currency in another column, or with
 * a leading sign, or wrapped in brackets the way an accounting export writes a
 * negative. All three become minor units.
 */
export function readMinorUnits(row: Row, column: string): Result<number> {
  const raw = row[column];
  if (isBlank(raw)) {
    return fail('field_missing', `${column} is empty`, column);
  }
  let text = (raw as string).replace(/[$,\s]/g, '').trim();
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    return fail('field_not_money', `${column} reads "${raw as string}"`, column);
  }
  const [whole, frac = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  return ok(negative ? -minor : minor);
}

export function readCurrency(row: Row, column: string): Result<Currency> {
  const text = readText(row, column);
  if (!text.ok) {
    return text;
  }
  const code = text.value.toUpperCase();
  return isCurrency(code)
    ? ok(code)
    : fail('field_not_currency', `${column} reads "${code}"`, column);
}

export function readDay(row: Row, column: string): Result<Day> {
  const text = readText(row, column);
  if (!text.ok) {
    return text;
  }
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.value);
  const normalized =
    slashed === null
      ? text.value
      : `${slashed[3] as string}-${(slashed[1] as string).padStart(2, '0')}-${(slashed[2] as string).padStart(2, '0')}`;
  const parsed = parseDay(normalized);
  return parsed.ok ? parsed : fail('field_not_day', `${column} reads "${text.value}"`, column);
}

export function readInstant(row: Row, column: string): Result<Instant> {
  const text = readText(row, column);
  if (!text.ok) {
    return text;
  }
  const parsed = parseInstant(text.value.replace(' ', 'T'));
  return parsed.ok ? parsed : fail('field_not_instant', `${column} reads "${text.value}"`, column);
}

export function readOneOf<T extends string>(
  row: Row,
  column: string,
  allowed: readonly T[],
): Result<T> {
  const text = readText(row, column);
  if (!text.ok) {
    return text;
  }
  const word = text.value.toLowerCase().replace(/[\s-]+/g, '_');
  const found = allowed.find((candidate) => candidate === word);
  return found === undefined
    ? fail('field_not_allowed', `${column} reads "${text.value}"`, column)
    : ok(found);
}

export function requireColumns(row: Row, columns: readonly string[]): Result<Row> {
  const missing = columns.filter((column) => !(column in row));
  if (missing.length > 0) {
    return fail('row_columns_missing', `the row has no ${missing.join(', ')}`);
  }
  return ok(row);
}
