/**
 * A result carries either a value or a list of problems. Nothing in this
 * codebase throws for an expected failure, because a batch of five thousand
 * referral touches with one bad row has to keep going and report the row.
 */

export interface Problem {
  readonly code: string;
  readonly message: string;
  readonly path?: string | undefined;
}

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err {
  readonly ok: false;
  readonly problems: readonly Problem[];
}

export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(problems: readonly Problem[]): Err {
  if (problems.length === 0) {
    throw new Error('err() needs at least one problem');
  }
  return { ok: false, problems };
}

export function problem(code: string, message: string, path?: string): Problem {
  return path === undefined ? { code, message } : { code, message, path };
}

export function fail(code: string, message: string, path?: string): Err {
  return err([problem(code, message, path)]);
}

export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok;
}

export function isErr<T>(result: Result<T>): result is Err {
  return !result.ok;
}

/** Unwrap or throw. Only for callers that have already checked, and for tests. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  const summary = result.problems.map((p) => `${p.code}: ${p.message}`).join('; ');
  throw new Error(`unwrap on a failed result: ${summary}`);
}

export function map<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function flatMap<T, U>(result: Result<T>, fn: (value: T) => Result<U>): Result<U> {
  return result.ok ? fn(result.value) : result;
}

/** Collect a list of results, gathering every problem rather than stopping. */
export function all<T>(results: readonly Result<T>[]): Result<T[]> {
  const values: T[] = [];
  const problems: Problem[] = [];
  for (const result of results) {
    if (result.ok) {
      values.push(result.value);
    } else {
      problems.push(...result.problems);
    }
  }
  return problems.length > 0 ? err(problems) : ok(values);
}

/** Prefix every problem path, so nested validators report where they were. */
export function withPath(result: Err, prefix: string): Err {
  return err(
    result.problems.map((p) => ({
      ...p,
      path: p.path === undefined ? prefix : `${prefix}.${p.path}`,
    })),
  );
}
