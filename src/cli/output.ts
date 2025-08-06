/**
 * What the command line writes and what it exits with.
 *
 * Nothing in this program calls console directly except through here, so a
 * command can be run in a test and its output read without capturing a global.
 * The exit codes are the other half of that: a script driving this needs to
 * know whether a run found nothing, failed, or was told to do something it
 * would not do.
 */

import { describeError, errorFrom, type ApiError } from '../api/errors.js';
import type { Problem, Result } from '../util/result.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;
export const EXIT_NOTHING_FOUND = 3;

export interface Sink {
  out(line: string): void;
  err(line: string): void;
}

export function consoleSink(): Sink {
  return {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  };
}

export class RecordingSink implements Sink {
  readonly lines: string[] = [];
  readonly errors: string[] = [];

  out(line: string): void {
    this.lines.push(line);
  }

  err(line: string): void {
    this.errors.push(line);
  }

  get output(): string {
    return this.lines.join('\n');
  }

  get errorOutput(): string {
    return this.errors.join('\n');
  }
}

export function exitCodeFor(error: ApiError): number {
  if (error.status === 409 || error.status === 422) {
    return EXIT_REFUSED;
  }
  if (error.status === 404) {
    return EXIT_NOTHING_FOUND;
  }
  return EXIT_FAILED;
}

export function reportProblems(sink: Sink, problems: readonly Problem[]): number {
  const error = errorFrom(problems);
  sink.err(describeError(error));
  for (const problem of problems.slice(1)) {
    sink.err(`  also ${problem.code}: ${problem.message}`);
  }
  return exitCodeFor(error);
}

/** Write a result, or report why it failed, and give back the exit code. */
export function emit<T>(sink: Sink, result: Result<T>, render: (value: T) => string): number {
  if (!result.ok) {
    return reportProblems(sink, result.problems);
  }
  const text = render(result.value);
  if (text !== '') {
    sink.out(text);
  }
  return EXIT_OK;
}

export function emitJson<T>(sink: Sink, result: Result<T>): number {
  return emit(sink, result, (value) => JSON.stringify(value, null, 2));
}

export function emitLines(sink: Sink, lines: readonly string[]): number {
  for (const line of lines) {
    sink.out(line);
  }
  return EXIT_OK;
}

export function describeExit(code: number): string {
  switch (code) {
    case EXIT_OK:
      return 'ok';
    case EXIT_FAILED:
      return 'failed';
    case EXIT_REFUSED:
      return 'refused';
    case EXIT_NOTHING_FOUND:
      return 'nothing found';
    default:
      return `exit ${code}`;
  }
}
