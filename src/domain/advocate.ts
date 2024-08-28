/**
 * An advocate is a carrier enrolled in the referral program. Enrolment is not
 * permanent and it is not a flag: it is a run of enrolment spells, because a
 * carrier who leaves and comes back starts a fresh program year, and the
 * program year is what the tier ladder accumulates over.
 */

import { addDays, addMonths, compareDays, isBefore, type Day } from '../util/clock.js';
import { interval, type DayInterval } from '../util/interval.js';
import { chain, ascending, byKey, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, CarrierId, ProgramId } from './identity.js';

export type EnrolmentEndReason = 'withdrew' | 'suspended' | 'authority_lost' | 'program_closed';

export interface EnrolmentSpell {
  readonly from: Day;
  readonly until?: Day;
  readonly endReason?: EnrolmentEndReason;
}

export interface Advocate {
  readonly id: AdvocateId;
  readonly carrier: CarrierId;
  readonly program: ProgramId;
  readonly referralCode: string;
  readonly spells: readonly EnrolmentSpell[];
}

export function spellInterval(spell: EnrolmentSpell, openEnd: Day): DayInterval {
  const cap = compareDays(openEnd, spell.from) >= 0 ? openEnd : spell.from;
  return interval(spell.from, spell.until ?? addDays(cap, 1));
}

export function spellContains(spell: EnrolmentSpell, when: Day): boolean {
  if (isBefore(when, spell.from)) {
    return false;
  }
  return spell.until === undefined || isBefore(when, spell.until);
}

export function isEnrolledOn(advocate: Advocate, when: Day): boolean {
  return advocate.spells.some((spell) => spellContains(spell, when));
}

export function spellCoveringDay(advocate: Advocate, when: Day): EnrolmentSpell | undefined {
  return advocate.spells.find((spell) => spellContains(spell, when));
}

export function currentSpell(advocate: Advocate): EnrolmentSpell | undefined {
  const open = advocate.spells.filter((spell) => spell.until === undefined);
  return sorted(
    open,
    byKey((s: EnrolmentSpell) => s.from, compareDays),
  ).at(-1);
}

export function firstEnrolmentDay(advocate: Advocate): Day | undefined {
  return sorted(
    advocate.spells,
    byKey((s: EnrolmentSpell) => s.from, compareDays),
  ).at(0)?.from;
}

/**
 * The program year that owns a day. It runs twelve months from the start of the
 * spell that covers the day, repeating, so an advocate enrolled in March always
 * has a program year that turns over in March.
 */
export function programYearOf(advocate: Advocate, when: Day): Result<DayInterval> {
  const spell = spellCoveringDay(advocate, when);
  if (spell === undefined) {
    return fail('advocate_not_enrolled', `advocate was not enrolled on the day in question`);
  }
  let from = spell.from;
  let until = addMonths(from, 12);
  while (!isBefore(when, until)) {
    from = until;
    until = addMonths(from, 12);
  }
  return ok(interval(from, until));
}

export function validateSpells(
  spells: readonly EnrolmentSpell[],
): Result<readonly EnrolmentSpell[]> {
  const openCount = spells.filter((spell) => spell.until === undefined).length;
  if (openCount > 1) {
    return fail('enrolment_two_open_spells', 'an advocate cannot have two open enrolments');
  }
  const ordered = sorted(
    spells,
    chain(
      byKey((s: EnrolmentSpell) => s.from, compareDays),
      byKey((s: EnrolmentSpell) => (s.until === undefined ? 1 : 0), ascending),
    ),
  );
  for (let i = 0; i < ordered.length; i += 1) {
    const spell = ordered[i] as EnrolmentSpell;
    if (spell.until !== undefined && !isBefore(spell.from, spell.until)) {
      return fail('enrolment_spell_inverted', 'an enrolment spell must end after it starts');
    }
    const next = ordered[i + 1];
    if (next !== undefined) {
      if (spell.until === undefined || compareDays(spell.until, next.from) > 0) {
        return fail('enrolment_spells_overlap', 'enrolment spells cannot overlap');
      }
    }
  }
  return ok(ordered);
}

export function withdraw(
  advocate: Advocate,
  on: Day,
  reason: EnrolmentEndReason,
): Result<Advocate> {
  const spell = currentSpell(advocate);
  if (spell === undefined) {
    return fail('advocate_not_enrolled', 'there is no open enrolment to withdraw');
  }
  if (!isBefore(spell.from, on)) {
    return fail(
      'enrolment_spell_inverted',
      'an enrolment cannot end on or before the day it began',
    );
  }
  const spells = advocate.spells.map((candidate) =>
    candidate === spell ? { from: candidate.from, until: on, endReason: reason } : candidate,
  );
  return ok({ ...advocate, spells });
}

export function reEnrol(advocate: Advocate, on: Day): Result<Advocate> {
  if (currentSpell(advocate) !== undefined) {
    return fail('enrolment_two_open_spells', 'the advocate is already enrolled');
  }
  const spells = [...advocate.spells, { from: on }];
  const validated = validateSpells(spells);
  return validated.ok ? ok({ ...advocate, spells: validated.value }) : validated;
}
