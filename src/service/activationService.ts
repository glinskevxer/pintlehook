/**
 * Activation. This service is thin on purpose: it reads the onboarding row,
 * looks up the cure window from the program version in force on the approval
 * day, and asks the domain rule.
 *
 * The lookup day is the approval day and not today. A program change made after
 * a packet was approved must not reach back and re date an activation that has
 * already decided an attribution window, and the only way to be sure of that is
 * to never ask the catalogue about today.
 */

import type { Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import {
  isPending,
  resolveActivation,
  type ActivationOutcome,
  type PacketApproval,
} from '../domain/activation.js';
import type { ProgramId } from '../domain/identity.js';
import type { OnboardingDraft } from '../ingest/onboardingFeed.js';
import { rulesFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';

export interface ActivationRequest {
  readonly program: ProgramId;
  readonly approval: PacketApproval;
  readonly asOf: Day;
}

export function approvalOf(draft: OnboardingDraft): PacketApproval {
  return draft.approvalKind === 'outright'
    ? { kind: 'outright', approvedOn: draft.approvedOn }
    : {
        kind: 'conditional',
        approvedOn: draft.approvedOn,
        insuranceClearedOn: draft.insuranceClearedOn,
      };
}

export function activationFor(
  catalog: Catalog,
  request: ActivationRequest,
): Result<ActivationOutcome> {
  const rules = rulesFor(catalog, request.program, request.approval.approvedOn);
  if (!rules.ok) {
    return rules;
  }
  return resolveActivation(request.approval, rules.value.cureWindowDays, request.asOf);
}

export function activationForDraft(
  context: Context,
  catalog: Catalog,
  program: ProgramId,
  draft: OnboardingDraft,
): Result<ActivationOutcome> {
  return activationFor(catalog, {
    program,
    approval: approvalOf(draft),
    asOf: context.clock.today(),
  });
}

export function effectiveActivationDay(outcome: ActivationOutcome): Result<Day> {
  return isPending(outcome)
    ? fail('activation_still_pending', 'this carrier has no effective activation yet')
    : ok(outcome.effectiveOn);
}

export interface ActivationSummary {
  readonly settled: number;
  readonly pending: number;
  readonly failed: number;
}

export function summarizeActivations(
  outcomes: readonly Result<ActivationOutcome>[],
): ActivationSummary {
  let settled = 0;
  let pending = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failed += 1;
    } else if (isPending(outcome.value)) {
      pending += 1;
    } else {
      settled += 1;
    }
  }
  return { settled, pending, failed };
}

/**
 * Whether two catalogue versions would date the same packet differently. The
 * settlement desk asks this before a rule change goes live, because a change
 * that moves an activation moves an attribution window with it.
 */
export function wouldMoveActivation(
  before: Catalog,
  after: Catalog,
  request: ActivationRequest,
): Result<boolean> {
  const one = activationFor(before, request);
  if (!one.ok) {
    return one;
  }
  const other = activationFor(after, request);
  if (!other.ok) {
    return other;
  }
  if (isPending(one.value) || isPending(other.value)) {
    return ok(isPending(one.value) !== isPending(other.value));
  }
  return ok(one.value.effectiveOn !== other.value.effectiveOn);
}
