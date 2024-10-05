/**
 * A referral is one invited carrier under one program, and it is the thing the
 * ladder counts. It moves through a small set of states, and the moves are one
 * way apart from the two that undo a qualification.
 *
 * The state is derived rather than stored wherever it can be, because a stored
 * state and a recomputed one drift apart the first time a feed is replayed.
 */

import { compareDays, type Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, CarrierId, ProgramId } from './identity.js';

export type ReferralState =
  | 'recorded'
  | 'pending_activation'
  | 'attributed'
  | 'unattributed'
  | 'qualified'
  | 'lapsed'
  | 'reversed';

export const TERMINAL_STATES: readonly ReferralState[] = ['unattributed', 'lapsed', 'reversed'];

const ALLOWED: Record<ReferralState, readonly ReferralState[]> = {
  recorded: ['pending_activation', 'attributed', 'unattributed'],
  pending_activation: ['attributed', 'unattributed', 'lapsed'],
  attributed: ['qualified', 'lapsed'],
  unattributed: [],
  qualified: ['reversed'],
  lapsed: ['attributed'],
  reversed: ['qualified'],
};

export interface Referral {
  readonly program: ProgramId;
  readonly invitee: CarrierId;
  readonly advocate?: AdvocateId | undefined;
  readonly state: ReferralState;
  readonly recordedOn: Day;
  readonly effectiveActivation?: Day | undefined;
  readonly qualifiedOn?: Day | undefined;
  readonly reversedOn?: Day | undefined;
}

export function canMove(from: ReferralState, to: ReferralState): boolean {
  return (ALLOWED[from] as readonly string[]).includes(to);
}

export function isTerminal(state: ReferralState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isEarning(state: ReferralState): boolean {
  return state === 'qualified';
}

export function moveTo(referral: Referral, to: ReferralState): Result<Referral> {
  if (referral.state === to) {
    return ok(referral);
  }
  if (!canMove(referral.state, to)) {
    return fail('referral_bad_transition', `a referral cannot go from ${referral.state} to ${to}`);
  }
  return ok({ ...referral, state: to });
}

export function attribute(referral: Referral, advocate: AdvocateId, on: Day): Result<Referral> {
  const moved = moveTo(referral, 'attributed');
  if (!moved.ok) {
    return moved;
  }
  if (compareDays(on, referral.recordedOn) < 0) {
    return fail(
      'referral_activation_before_record',
      'a referral cannot activate before it was recorded',
    );
  }
  return ok({ ...moved.value, advocate, effectiveActivation: on });
}

export function qualify(referral: Referral, on: Day): Result<Referral> {
  if (referral.advocate === undefined) {
    return fail('referral_qualify_unattributed', 'an unattributed referral cannot qualify');
  }
  if (referral.effectiveActivation === undefined) {
    return fail('referral_qualify_unactivated', 'a referral with no activation cannot qualify');
  }
  if (compareDays(on, referral.effectiveActivation) < 0) {
    return fail(
      'referral_qualify_before_activation',
      'a referral cannot qualify before the carrier activated',
    );
  }
  const moved = moveTo(referral, 'qualified');
  return moved.ok ? ok({ ...moved.value, qualifiedOn: on, reversedOn: undefined }) : moved;
}

export function reverse(referral: Referral, on: Day): Result<Referral> {
  if (referral.qualifiedOn === undefined) {
    return fail('referral_reverse_unqualified', 'only a qualified referral can be reversed');
  }
  if (compareDays(on, referral.qualifiedOn) < 0) {
    return fail(
      'referral_reverse_before_qualification',
      'a referral cannot be reversed before it qualified',
    );
  }
  const moved = moveTo(referral, 'reversed');
  return moved.ok ? ok({ ...moved.value, reversedOn: on }) : moved;
}

export function referralKey(referral: Referral): string {
  return `${referral.program}:${referral.invitee}`;
}

export function describeReferral(referral: Referral): string {
  const who = referral.advocate ?? 'nobody';
  return `${referral.invitee} referred by ${who}, ${referral.state}`;
}
