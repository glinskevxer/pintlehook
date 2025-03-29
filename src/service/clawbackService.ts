/**
 * Clawback over the store. Reads the invited carrier's claims and the retention
 * assessment, asks the domain rule, and writes the reversal.
 *
 * A reversal here does not touch a single accrual. It reverses the referral,
 * and the accrual engine is run again afterwards, which is what produces the
 * true downs. Keeping the two apart is the reason a clawback can drop an
 * advocate a tier without anybody writing a rule that says so.
 */

import { formatDay, type Day } from '../util/clock.js';
import { money, type Currency, type Money } from '../util/money.js';
import type { BasisPoints } from '../util/rate.js';
import { fail, ok, type Result } from '../util/result.js';
import {
  assessClawback,
  type CargoClaim,
  type ClaimDisposition,
  type ClawbackOutcome,
} from '../domain/clawback.js';
import type { CarrierId, ClaimId, ProgramId } from '../domain/identity.js';
import { assessRetention, type RetentionAssessment } from '../domain/retention.js';
import type { JournalDraft } from '../storage/journal.js';
import { claimsForCarrier, loadsOfCarrier, referralByKey } from '../storage/repositories.js';
import { readDayText, type ClaimRow } from '../storage/rows.js';
import { referralKeyOf } from '../storage/store.js';
import { rulesFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';
import { loadOf } from './qualificationService.js';

export const DEFAULT_CHECKPOINT_DAYS = 60;
export const DEFAULT_CLAIM_TOLERANCE: BasisPoints = 2500;

export function claimOf(row: ClaimRow): Result<CargoClaim> {
  const raisedOn = readDayText(row.raisedOn, 'raisedOn');
  if (!raisedOn.ok) {
    return raisedOn;
  }
  if (raisedOn.value === undefined) {
    return fail('claim_raised_missing', `claim ${row.id} has no raised day`);
  }
  return ok({
    id: row.id as ClaimId,
    load: row.load as CargoClaim['load'],
    raisedOn: raisedOn.value,
    disposition: row.disposition as ClaimDisposition,
    amountMinor: row.amountMinor,
    currency: row.currency as Currency,
  });
}

export interface ClawbackRequest {
  readonly program: ProgramId;
  readonly invitee: CarrierId;
  readonly qualifiedOn: Day;
  readonly deliveredMargin: Money;
  readonly checkpointDays?: number | undefined;
  readonly authorityLostOn?: Day | undefined;
  readonly claimTolerance?: BasisPoints | undefined;
}

export interface ClawbackAssessment {
  readonly retention: RetentionAssessment;
  readonly clawback: ClawbackOutcome;
}

export function assessReferral(
  context: Context,
  catalog: Catalog,
  request: ClawbackRequest,
): Result<ClawbackAssessment> {
  const rules = rulesFor(catalog, request.program, request.qualifiedOn);
  if (!rules.ok) {
    return rules;
  }
  const loads = [];
  for (const row of loadsOfCarrier(context.store, request.invitee)) {
    const load = loadOf(row);
    if (!load.ok) {
      return load;
    }
    loads.push(load.value);
  }
  const retention = assessRetention({
    loads,
    qualifiedOn: request.qualifiedOn,
    retentionDays: rules.value.retentionDays,
    checkpointDays: request.checkpointDays ?? DEFAULT_CHECKPOINT_DAYS,
    asOf: context.clock.today(),
    authorityLostOn: request.authorityLostOn,
  });
  if (!retention.ok) {
    return retention;
  }
  const claims: CargoClaim[] = [];
  for (const row of claimsForCarrier(context.store, request.invitee)) {
    const claim = claimOf(row);
    if (!claim.ok) {
      return claim;
    }
    claims.push(claim.value);
  }
  const clawback = assessClawback({
    claims,
    deliveredMargin: request.deliveredMargin,
    retentionFailedOn: retention.value.failedOn,
    policy: {
      claimToleranceShare: request.claimTolerance ?? DEFAULT_CLAIM_TOLERANCE,
      retentionWindow: retention.value.window,
      currency: rules.value.currency,
    },
  });
  return clawback.ok ? ok({ retention: retention.value, clawback: clawback.value }) : clawback;
}

export function clawbackDrafts(
  context: Context,
  request: ClawbackRequest,
  assessment: ClawbackAssessment,
): Result<JournalDraft[]> {
  if (!assessment.clawback.clawed) {
    return fail('clawback_not_triggered', 'nothing about this referral claws back');
  }
  const on = assessment.clawback.on;
  if (on === undefined) {
    return fail('clawback_no_date', 'a clawback has to carry the day it happened');
  }
  const referral = referralByKey(context.store, request.program, request.invitee);
  if (!referral.ok) {
    return referral;
  }
  if (referral.value.state !== 'qualified') {
    return fail(
      'clawback_not_qualified',
      `the referral is ${referral.value.state} and only a qualified one can be reversed`,
    );
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'referral_reversed',
      key: referralKeyOf(request.program, request.invitee),
      payload: {
        program: request.program,
        invitee: request.invitee,
        reversedOn: formatDay(on),
        reason: assessment.clawback.reason ?? 'manual',
        chargedTotalMinor: assessment.clawback.chargedTotal.minor,
        actor: context.actor,
      },
    },
  ]);
}

export function marginAfterClaims(assessment: ClawbackAssessment): Money {
  return assessment.clawback.marginAfterClaims;
}

export function toleranceOf(assessment: ClawbackAssessment, currency: Currency): Money {
  return money(currency, assessment.clawback.tolerance.minor);
}
