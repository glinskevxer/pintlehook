/**
 * Eligibility flags. A flag is a reason the settlement desk will not pay an
 * advocate that has nothing to do with what they are owed: a missing tax form,
 * a lapsed authority, an open fraud review.
 *
 * Flags are raised and cleared by name, one row per advocate and flag, so
 * raising the same flag twice is not two flags and clearing it once clears it.
 * That sounds obvious and it is the thing every hand rolled flag table gets
 * wrong the first time.
 */

import { compareDays, formatDay, type Day } from '../util/clock.js';
import { byText, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, ProgramId } from '../domain/identity.js';
import type { JournalDraft } from '../storage/journal.js';
import { advocateById, enrolledAdvocates, openFlagsOf } from '../storage/repositories.js';
import { flagKey, isOpenFlag, readDayText, type FlagRow } from '../storage/rows.js';
import type { Context } from './context.js';

export const KNOWN_FLAGS = [
  'w9_missing',
  'authority_lapsed',
  'fraud_review',
  'remit_details_missing',
  'bank_details_stale',
] as const;

export type KnownFlag = (typeof KNOWN_FLAGS)[number];

export function isKnownFlag(value: string): value is KnownFlag {
  return (KNOWN_FLAGS as readonly string[]).includes(value);
}

export function raiseFlag(
  context: Context,
  advocate: AdvocateId,
  flag: string,
  on: Day,
): Result<JournalDraft[]> {
  if (!isKnownFlag(flag)) {
    return fail('eligibility_flag_unknown', `there is no flag called "${flag}"`);
  }
  const row = advocateById(context.store, advocate);
  if (!row.ok) {
    return row;
  }
  const held = context.store.flags.get(flagKey(advocate, flag));
  if (held !== undefined && isOpenFlag(held)) {
    return fail('eligibility_flag_already_open', `${flag} is already open on ${advocate}`);
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'eligibility_flag_raised',
      key: advocate,
      payload: { advocate, flag, raisedOn: formatDay(on), actor: context.actor },
    },
  ]);
}

export function clearFlag(
  context: Context,
  advocate: AdvocateId,
  flag: string,
  on: Day,
): Result<JournalDraft[]> {
  const held = context.store.flags.get(flagKey(advocate, flag));
  if (held === undefined) {
    return fail('eligibility_flag_not_raised', `${flag} was never raised on ${advocate}`);
  }
  if (!isOpenFlag(held)) {
    return fail('eligibility_flag_not_open', `${flag} is already cleared on ${advocate}`);
  }
  const raisedOn = readDayText(held.raisedOn, 'raisedOn');
  if (!raisedOn.ok) {
    return raisedOn;
  }
  if (raisedOn.value !== undefined && compareDays(on, raisedOn.value) < 0) {
    return fail('eligibility_flag_cleared_early', 'a flag cannot be cleared before it was raised');
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'eligibility_flag_cleared',
      key: advocate,
      payload: { advocate, flag, clearedOn: formatDay(on), actor: context.actor },
    },
  ]);
}

export interface FlagSummary {
  readonly advocate: string;
  readonly open: readonly string[];
}

export function openFlagsAcross(context: Context, program: ProgramId): FlagSummary[] {
  const summaries: FlagSummary[] = [];
  for (const advocate of enrolledAdvocates(context.store, program)) {
    const open = openFlagsOf(context.store, advocate.id);
    if (open.length > 0) {
      summaries.push({ advocate: advocate.id, open });
    }
  }
  return sorted(summaries, (left, right) => byText(left.advocate, right.advocate));
}

export function flagHistory(context: Context, advocate: AdvocateId): FlagRow[] {
  const rows = context.store.flags.by('advocate', advocate);
  return rows.ok ? sorted(rows.value, (left, right) => byText(left.flag, right.flag)) : [];
}

export function blocksPayment(context: Context, advocate: AdvocateId): boolean {
  return openFlagsOf(context.store, advocate).length > 0;
}
