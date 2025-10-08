/**
 * Reading the values a request carries.
 *
 * Four route modules were each reading a day, a currency and an identifier
 * their own way, and two of them defaulted a missing day to today while the
 * third refused it. Whichever answer is right, it has to be one answer, so it
 * lives here.
 */

import { parseDay, type Day } from '../util/clock.js';
import { isCurrency, type Currency } from '../util/money.js';
import { fail, ok, type Result } from '../util/result.js';
import type { Context } from '../service/context.js';
import { optionalQuery, requiredQuery, type ApiRequest } from './router.js';

export function bodyText(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

export function requiredBodyText(
  body: Readonly<Record<string, unknown>>,
  field: string,
): Result<string> {
  const value = bodyText(body, field);
  return value.trim() === ''
    ? fail('body_field_missing', `${field} is required`, field)
    : ok(value.trim());
}

export function requiredBodyDay(
  body: Readonly<Record<string, unknown>>,
  field: string,
): Result<Day> {
  const value = requiredBodyText(body, field);
  return value.ok ? parseDay(value.value) : value;
}

/** A day off the query, defaulting to whatever the context clock says. */
export function queryDayOrToday(context: Context, request: ApiRequest, name: string): Result<Day> {
  const raw = optionalQuery(request, name);
  return raw === undefined ? ok(context.clock.today()) : parseDay(raw);
}

export function queryCurrency(request: ApiRequest, name: string): Result<Currency> {
  const raw = optionalQuery(request, name) ?? 'USD';
  return isCurrency(raw)
    ? ok(raw)
    : fail('query_currency_unsupported', `we do not carry ${raw}`, name);
}

export function bodyCurrency(
  body: Readonly<Record<string, unknown>>,
  field: string,
): Result<Currency> {
  const raw = bodyText(body, field) || 'USD';
  return isCurrency(raw)
    ? ok(raw)
    : fail('body_currency_unsupported', `we do not carry ${raw}`, field);
}

export function pathValue(params: Readonly<Record<string, string>>, name: string): Result<string> {
  const value = params[name];
  return value === undefined || value.trim() === ''
    ? fail('query_missing', `the ${name} is required`, name)
    : ok(value.trim());
}

export function requiredQueryValue(request: ApiRequest, name: string): Result<string> {
  return requiredQuery(request, name);
}
