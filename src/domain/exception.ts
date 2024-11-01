/**
 * Exceptions. Everything the program could not decide by itself ends up here,
 * and the exception report is the only screen the referral desk actually works
 * from, so the taxonomy has to be about what somebody would do next rather than
 * about which module noticed.
 */

import { compareDays, daysBetween, type Day } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { ascending, byKey, byText, chain, groupBy, sorted } from '../util/ordering.js';
import type { Comparator } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';

export type ExceptionKind =
  | 'unattributed_referral'
  | 'screened_referral'
  | 'activation_pending'
  | 'cure_expired'
  | 'qualifying_window_lapsed'
  | 'retention_failed'
  | 'claim_charged_back'
  | 'recovery_stale'
  | 'settlement_held'
  | 'feed_row_rejected'
  | 'duplicate_load'
  | 'unknown_referral_code';

export type ExceptionSeverity = 'action' | 'review' | 'note';

const SEVERITY: Record<ExceptionKind, ExceptionSeverity> = {
  unattributed_referral: 'review',
  screened_referral: 'review',
  activation_pending: 'note',
  cure_expired: 'action',
  qualifying_window_lapsed: 'note',
  retention_failed: 'action',
  claim_charged_back: 'action',
  recovery_stale: 'action',
  settlement_held: 'action',
  feed_row_rejected: 'action',
  duplicate_load: 'review',
  unknown_referral_code: 'review',
};

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { action: 1, review: 2, note: 3 };

export interface ProgramException {
  readonly kind: ExceptionKind;
  readonly subject: string;
  readonly raisedOn: Day;
  readonly detail: string;
  readonly clearedOn?: Day | undefined;
}

export function severityOf(kind: ExceptionKind): ExceptionSeverity {
  return SEVERITY[kind];
}

export function isOpen(exception: ProgramException): boolean {
  return exception.clearedOn === undefined;
}

export function needsAction(exception: ProgramException): boolean {
  return isOpen(exception) && severityOf(exception.kind) === 'action';
}

export function exceptionKey(exception: ProgramException): string {
  return digestOfParts([exception.kind, exception.subject]);
}

export const exceptionOrder: Comparator<ProgramException> = chain(
  byKey((e: ProgramException) => SEVERITY_RANK[severityOf(e.kind)], ascending),
  byKey((e: ProgramException) => e.raisedOn, compareDays),
  byKey((e: ProgramException) => e.subject, byText),
);

export function openOnly(exceptions: readonly ProgramException[]): ProgramException[] {
  return sorted(exceptions.filter(isOpen), exceptionOrder);
}

export function countByKind(exceptions: readonly ProgramException[]): Map<ExceptionKind, number> {
  const counts = new Map<ExceptionKind, number>();
  for (const [kind, group] of groupBy(exceptions, (e) => e.kind)) {
    counts.set(kind, group.length);
  }
  return counts;
}

export function ageInDays(exception: ProgramException, asOf: Day): number {
  const to = exception.clearedOn ?? asOf;
  return Math.max(0, daysBetween(exception.raisedOn, to));
}

export function clear(exception: ProgramException, on: Day): Result<ProgramException> {
  if (exception.clearedOn !== undefined) {
    return fail('exception_already_cleared', 'this exception was already cleared');
  }
  if (compareDays(on, exception.raisedOn) < 0) {
    return fail(
      'exception_cleared_before_raised',
      'an exception cannot clear before it was raised',
    );
  }
  return ok({ ...exception, clearedOn: on });
}

/**
 * Fold a stream of exceptions to the current one per subject and kind, keeping
 * the latest. A feed replayed twice must not double the working list.
 */
export function latestPerSubject(exceptions: readonly ProgramException[]): ProgramException[] {
  const latest = new Map<string, ProgramException>();
  for (const exception of sorted(exceptions, exceptionOrder)) {
    const key = exceptionKey(exception);
    const held = latest.get(key);
    if (held === undefined || compareDays(exception.raisedOn, held.raisedOn) >= 0) {
      latest.set(key, exception);
    }
  }
  return sorted([...latest.values()], exceptionOrder);
}

export function describeException(exception: ProgramException): string {
  const state = isOpen(exception) ? 'open' : 'cleared';
  return `${exception.kind} on ${exception.subject}, ${state}`;
}
