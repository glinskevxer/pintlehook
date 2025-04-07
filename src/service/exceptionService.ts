/**
 * Building the exception list out of the store.
 *
 * Nothing here decides anything. Every exception is a restatement of a state
 * the rules already produced, which is why the list can be rebuilt from
 * scratch on every run and why it never needs its own storage. A working list
 * that drifts from the thing it describes is worse than no working list.
 */

import { addDays, compareDays, type Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import type { ProgramId } from '../domain/identity.js';
import {
  exceptionOrder,
  latestPerSubject,
  needsAction,
  severityOf,
  type ExceptionKind,
  type ProgramException,
} from '../domain/exception.js';
import { sorted } from '../util/ordering.js';
import {
  enrolledAdvocates,
  hasOpenFlags,
  openFlagsOf,
  referralsInState,
} from '../storage/repositories.js';
import { NO_DAY, readDayText } from '../storage/rows.js';
import { rulesFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';

function raise(
  kind: ExceptionKind,
  subject: string,
  raisedOn: Day,
  detail: string,
): ProgramException {
  return { kind, subject, raisedOn, detail, clearedOn: undefined };
}

export function unattributedReferrals(context: Context): ProgramException[] {
  const found: ProgramException[] = [];
  for (const row of referralsInState(context.store, 'recorded')) {
    const recordedOn = readDayText(row.recordedOn, 'recordedOn');
    if (!recordedOn.ok || recordedOn.value === undefined) {
      continue;
    }
    found.push(
      raise('unattributed_referral', row.key, recordedOn.value, 'nothing has been credited yet'),
    );
  }
  return found;
}

export function lapsedQualifyingWindows(
  context: Context,
  catalog: Catalog,
  program: ProgramId,
): Result<ProgramException[]> {
  const found: ProgramException[] = [];
  for (const row of referralsInState(context.store, 'attributed')) {
    if (row.program !== program || row.effectiveActivation === NO_DAY) {
      continue;
    }
    const activation = readDayText(row.effectiveActivation, 'effectiveActivation');
    if (!activation.ok) {
      return activation;
    }
    if (activation.value === undefined) {
      continue;
    }
    const rules = rulesFor(catalog, program, activation.value);
    if (!rules.ok) {
      return rules;
    }
    const closesOn = addDays(activation.value, rules.value.qualifyingWindowDays);
    if (compareDays(context.clock.today(), closesOn) >= 0) {
      found.push(
        raise('qualifying_window_lapsed', row.key, closesOn, 'the window closed without the loads'),
      );
    }
  }
  return ok(found);
}

export function reversedReferrals(context: Context): ProgramException[] {
  const found: ProgramException[] = [];
  for (const row of referralsInState(context.store, 'reversed')) {
    const reversedOn = readDayText(row.reversedOn, 'reversedOn');
    if (!reversedOn.ok || reversedOn.value === undefined) {
      continue;
    }
    found.push(raise('retention_failed', row.key, reversedOn.value, 'the bounty was clawed back'));
  }
  return found;
}

export function openEligibilityFlags(context: Context, program: ProgramId): ProgramException[] {
  const found: ProgramException[] = [];
  for (const advocate of enrolledAdvocates(context.store, program)) {
    if (!hasOpenFlags(context.store, advocate.id)) {
      continue;
    }
    found.push(
      raise(
        'settlement_held',
        advocate.id,
        context.clock.today(),
        `open flags: ${openFlagsOf(context.store, advocate.id).join(', ')}`,
      ),
    );
  }
  return found;
}

export function buildExceptions(
  context: Context,
  catalog: Catalog,
  program: ProgramId,
): Result<ProgramException[]> {
  const lapsed = lapsedQualifyingWindows(context, catalog, program);
  if (!lapsed.ok) {
    return lapsed;
  }
  const all = [
    ...unattributedReferrals(context),
    ...lapsed.value,
    ...reversedReferrals(context),
    ...openEligibilityFlags(context, program),
  ];
  return ok(latestPerSubject(all));
}

export function actionList(exceptions: readonly ProgramException[]): ProgramException[] {
  return sorted(exceptions.filter(needsAction), exceptionOrder);
}

export function countBySeverity(
  exceptions: readonly ProgramException[],
): Record<'action' | 'review' | 'note', number> {
  const counts = { action: 0, review: 0, note: 0 };
  for (const exception of exceptions) {
    counts[severityOf(exception.kind)] += 1;
  }
  return counts;
}

export function requireProgram(catalog: Catalog, program: ProgramId): Result<ProgramId> {
  return catalog.programs.some((candidate) => candidate.id === program)
    ? ok(program)
    : fail('catalog_program_unknown', `no program ${program}`);
}
