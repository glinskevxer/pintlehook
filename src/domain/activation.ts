/**
 * Effective activation dating. This is the first of the rules that decides what
 * other rules measure, so it is worth stating plainly.
 *
 * A carrier packet is approved either outright or conditionally. A conditional
 * approval is given while the certificate of insurance is still outstanding,
 * and it carries a cure window. If the certificate lands inside that window the
 * activation backdates to the conditional approval day. If it lands after, the
 * activation is the day the certificate cleared, and the backdating is lost.
 *
 * Everything downstream measures from effective activation: the attribution
 * window runs backwards from it, and the qualifying window runs forwards from
 * it. So a cure window that is one day short does not merely delay a bounty, it
 * can hand the bounty to a different advocate.
 */

import { addDays, compareDays, isBefore, type Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';

export type ApprovalKind = 'outright' | 'conditional';

export interface PacketApproval {
  readonly kind: ApprovalKind;
  readonly approvedOn: Day;
  /** Present when the packet was approved conditionally. */
  readonly insuranceClearedOn?: Day | undefined;
}

export type ActivationBasis =
  | 'outright_approval'
  | 'cured_in_window'
  | 'cured_late'
  | 'awaiting_insurance';

export interface Activation {
  readonly effectiveOn: Day;
  readonly basis: ActivationBasis;
  /** Days the certificate took, counted from the conditional approval. */
  readonly cureDays?: number | undefined;
  readonly backdated: boolean;
}

export interface PendingActivation {
  readonly basis: 'awaiting_insurance';
  readonly since: Day;
  readonly cureExpiresOn: Day;
}

export type ActivationOutcome = Activation | PendingActivation;

export function isPending(outcome: ActivationOutcome): outcome is PendingActivation {
  return outcome.basis === 'awaiting_insurance';
}

/**
 * Resolve the activation. The caller passes the cure window from the program
 * version in force on the approval day, which is deliberate: a program change
 * after the approval does not reach back and re date an activation.
 */
export function resolveActivation(
  approval: PacketApproval,
  cureWindowDays: number,
  asOf: Day,
): Result<ActivationOutcome> {
  if (!Number.isInteger(cureWindowDays) || cureWindowDays <= 0) {
    return fail(
      'activation_cure_window',
      'the cure window must be a positive whole number of days',
    );
  }
  if (approval.kind === 'outright') {
    if (approval.insuranceClearedOn !== undefined) {
      return fail(
        'activation_outright_with_cure',
        'an outright approval cannot also carry an insurance clearance day',
      );
    }
    return ok({
      effectiveOn: approval.approvedOn,
      basis: 'outright_approval',
      backdated: false,
    });
  }
  const cureExpiresOn = addDays(approval.approvedOn, cureWindowDays);
  const cleared = approval.insuranceClearedOn;
  if (cleared === undefined) {
    if (isBefore(asOf, cureExpiresOn)) {
      return ok({ basis: 'awaiting_insurance', since: approval.approvedOn, cureExpiresOn });
    }
    return fail(
      'activation_cure_expired',
      'the cure window closed with no certificate, so there is no activation',
    );
  }
  if (isBefore(cleared, approval.approvedOn)) {
    return fail(
      'activation_cleared_before_approval',
      'the certificate cannot clear before the packet was approved',
    );
  }
  const cureDays = daysTaken(approval.approvedOn, cleared);
  if (isBefore(cleared, cureExpiresOn)) {
    return ok({
      effectiveOn: approval.approvedOn,
      basis: 'cured_in_window',
      cureDays,
      backdated: cureDays > 0,
    });
  }
  return ok({ effectiveOn: cleared, basis: 'cured_late', cureDays, backdated: false });
}

function daysTaken(from: Day, to: Day): number {
  let count = 0;
  let cursor = from;
  while (isBefore(cursor, to)) {
    cursor = addDays(cursor, 1);
    count += 1;
  }
  return count;
}

/** The last day a certificate can land and still backdate the activation. */
export function cureDeadline(approval: PacketApproval, cureWindowDays: number): Result<Day> {
  if (approval.kind !== 'conditional') {
    return fail('activation_not_conditional', 'only a conditional approval has a cure deadline');
  }
  if (!Number.isInteger(cureWindowDays) || cureWindowDays <= 0) {
    return fail(
      'activation_cure_window',
      'the cure window must be a positive whole number of days',
    );
  }
  return ok(addDays(approval.approvedOn, cureWindowDays - 1));
}

export function activationMoved(left: ActivationOutcome, right: ActivationOutcome): boolean {
  if (isPending(left) || isPending(right)) {
    return isPending(left) !== isPending(right);
  }
  return compareDays(left.effectiveOn, right.effectiveOn) !== 0;
}
