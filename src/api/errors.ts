/**
 * Turning a domain problem into something a caller can act on.
 *
 * The mapping is from the problem code prefix rather than from a per code
 * table, because a per code table has to be edited every time a rule gains a
 * failure and the one thing worse than a wrong status is a status that quietly
 * defaults to five hundred while somebody debugs a typo in a carrier number.
 */

import type { Problem } from '../util/result.js';

export type Status = 400 | 404 | 409 | 422 | 500;

export interface ApiError {
  readonly status: Status;
  readonly code: string;
  readonly message: string;
  readonly path?: string | undefined;
  readonly problems: readonly Problem[];
}

const NOT_FOUND = ['_unknown', '_not_registered', 'no_match'] as const;

const CONFLICT = [
  '_already_open',
  '_already_cleared',
  '_repeated',
  '_bad_transition',
  '_not_open',
  '_not_held',
  '_diverged',
] as const;

const UNPROCESSABLE = [
  '_not_liftable',
  '_not_met',
  '_not_triggered',
  '_uncredited',
  '_required',
  '_unattributed',
  '_too_early',
  '_expired',
] as const;

function endsWithAny(code: string, endings: readonly string[]): boolean {
  return endings.some((ending) => code.endsWith(ending));
}

export function statusFor(code: string): Status {
  if (endsWithAny(code, NOT_FOUND)) {
    return 404;
  }
  if (endsWithAny(code, CONFLICT)) {
    return 409;
  }
  if (endsWithAny(code, UNPROCESSABLE)) {
    return 422;
  }
  if (code.startsWith('internal_')) {
    return 500;
  }
  return 400;
}

export function errorFrom(problems: readonly Problem[]): ApiError {
  const first = problems[0];
  if (first === undefined) {
    return {
      status: 500,
      code: 'internal_no_problem',
      message: 'a failure arrived with nothing in it',
      problems: [],
    };
  }
  return {
    status: statusFor(first.code),
    code: first.code,
    message: first.message,
    path: first.path,
    problems,
  };
}

export function isClientError(error: ApiError): boolean {
  return error.status >= 400 && error.status < 500;
}

export function describeError(error: ApiError): string {
  const where = error.path === undefined ? '' : ` at ${error.path}`;
  return `${error.status} ${error.code}${where}: ${error.message}`;
}
