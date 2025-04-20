/**
 * The period close. This is the only place every layer is joined up, and it is
 * deliberately a script rather than a framework: attribute what can be
 * attributed, qualify what can be qualified, run the ladder, assess the
 * clawbacks, run the ladder again, then cut the batch.
 *
 * The ladder runs twice on purpose. The first pass posts what the qualifications
 * earned. The clawbacks then reverse referrals, and the second pass turns those
 * reversals into the true downs. Doing it in one pass would mean deciding the
 * order of two rules that are supposed to be independent.
 */

import { compareDays, type Day } from '../util/clock.js';
import type { DayInterval } from '../util/interval.js';
import { money, type Currency } from '../util/money.js';
import { ok, type Result } from '../util/result.js';
import type { AdvocateId, CarrierId, ProgramId } from '../domain/identity.js';
import {
  accrualsOfAdvocate,
  enrolledAdvocates,
  referralsInState,
} from '../storage/repositories.js';
import { NO_DAY, readDayText, requireDayText } from '../storage/rows.js';
import { runAccruals, type QualifiedReferral } from './accrualEngine.js';
import type { Catalog } from './catalog.js';
import { assessReferral, clawbackDrafts } from './clawbackService.js';
import type { Context } from './context.js';
import { qualificationDrafts, qualifyReferral } from './qualificationService.js';
import { cutBatch, type SettlementPlan } from './settlementService.js';

export interface CycleRequest {
  readonly program: ProgramId;
  readonly period: DayInterval;
  readonly cutOn: Day;
  readonly currency: Currency;
  readonly programYearFrom: Day;
}

export interface CycleReport {
  readonly qualified: number;
  readonly clawedBack: number;
  readonly accrualsPosted: number;
  readonly settlement: SettlementPlan;
}

/** Every attributed referral that might now meet its qualifying count. */
export function qualifyPass(
  context: Context,
  catalog: Catalog,
  program: ProgramId,
): Result<number> {
  let qualified = 0;
  for (const row of referralsInState(context.store, 'attributed')) {
    if (row.program !== program || row.effectiveActivation === NO_DAY) {
      continue;
    }
    const activation = requireDayText(row.effectiveActivation, 'effectiveActivation');
    if (!activation.ok) {
      return activation;
    }
    const request = {
      program,
      invitee: row.invitee as CarrierId,
      effectiveActivation: activation.value,
    };
    const outcome = qualifyReferral(context, catalog, request);
    if (!outcome.ok) {
      return outcome;
    }
    if (!outcome.value.qualified) {
      continue;
    }
    const drafts = qualificationDrafts(context, request, outcome.value);
    if (!drafts.ok) {
      return drafts;
    }
    const written = context.store.commit(drafts.value);
    if (!written.ok) {
      return written;
    }
    qualified += 1;
  }
  return ok(qualified);
}

/** Every qualified referral that has now failed retention or eaten a claim. */
export function clawbackPass(
  context: Context,
  catalog: Catalog,
  program: ProgramId,
): Result<number> {
  let clawed = 0;
  for (const row of referralsInState(context.store, 'qualified')) {
    if (row.program !== program || row.qualifiedOn === NO_DAY) {
      continue;
    }
    const qualifiedOn = requireDayText(row.qualifiedOn, 'qualifiedOn');
    if (!qualifiedOn.ok) {
      return qualifiedOn;
    }
    const activation = requireDayText(row.effectiveActivation, 'effectiveActivation');
    if (!activation.ok) {
      return activation;
    }
    const margin = qualifyReferral(context, catalog, {
      program,
      invitee: row.invitee as CarrierId,
      effectiveActivation: activation.value,
    });
    if (!margin.ok) {
      return margin;
    }
    const request = {
      program,
      invitee: row.invitee as CarrierId,
      qualifiedOn: qualifiedOn.value,
      deliveredMargin: margin.value.deliveredMargin,
    };
    const assessment = assessReferral(context, catalog, request);
    if (!assessment.ok) {
      return assessment;
    }
    if (!assessment.value.clawback.clawed) {
      continue;
    }
    const drafts = clawbackDrafts(context, request, assessment.value);
    if (!drafts.ok) {
      return drafts;
    }
    const written = context.store.commit(drafts.value);
    if (!written.ok) {
      return written;
    }
    clawed += 1;
  }
  return ok(clawed);
}

/** The qualified referrals an advocate holds inside one program year. */
export function qualifiedReferralsOf(
  context: Context,
  catalog: Catalog,
  advocate: AdvocateId,
  program: ProgramId,
  programYear: DayInterval,
): Result<QualifiedReferral[]> {
  const found: QualifiedReferral[] = [];
  for (const row of referralsInState(context.store, 'qualified')) {
    if (row.program !== program || row.advocate !== advocate) {
      continue;
    }
    const qualifiedOn = requireDayText(row.qualifiedOn, 'qualifiedOn');
    if (!qualifiedOn.ok) {
      return qualifiedOn;
    }
    if (
      compareDays(qualifiedOn.value, programYear.from) < 0 ||
      compareDays(qualifiedOn.value, programYear.until) >= 0
    ) {
      continue;
    }
    const activation = requireDayText(row.effectiveActivation, 'effectiveActivation');
    if (!activation.ok) {
      return activation;
    }
    const margin = qualifyReferral(context, catalog, {
      program,
      invitee: row.invitee as CarrierId,
      effectiveActivation: activation.value,
    });
    if (!margin.ok) {
      return margin;
    }
    found.push({
      referralKey: row.key,
      qualifiedOn: qualifiedOn.value,
      margin: margin.value.deliveredMargin,
    });
  }
  return ok(found);
}

export function accrualPass(
  context: Context,
  catalog: Catalog,
  request: CycleRequest,
  programYear: DayInterval,
): Result<number> {
  let posted = 0;
  for (const advocate of enrolledAdvocates(context.store, request.program)) {
    const referrals = qualifiedReferralsOf(
      context,
      catalog,
      advocate.id as AdvocateId,
      request.program,
      programYear,
    );
    if (!referrals.ok) {
      return referrals;
    }
    const plan = runAccruals(context, catalog, {
      advocate: advocate.id as AdvocateId,
      program: request.program,
      programYearFrom: request.programYearFrom,
      referrals: referrals.value,
      currency: request.currency,
    });
    if (!plan.ok) {
      return plan;
    }
    posted += plan.value.drafts.length;
  }
  return ok(posted);
}

export function runCycle(
  context: Context,
  catalog: Catalog,
  request: CycleRequest,
  programYear: DayInterval,
): Result<CycleReport> {
  const qualified = qualifyPass(context, catalog, request.program);
  if (!qualified.ok) {
    return qualified;
  }
  const firstAccruals = accrualPass(context, catalog, request, programYear);
  if (!firstAccruals.ok) {
    return firstAccruals;
  }
  const clawed = clawbackPass(context, catalog, request.program);
  if (!clawed.ok) {
    return clawed;
  }
  const secondAccruals = accrualPass(context, catalog, request, programYear);
  if (!secondAccruals.ok) {
    return secondAccruals;
  }
  const settlement = cutBatch(context, catalog, {
    program: request.program,
    period: request.period,
    cutOn: request.cutOn,
    currency: request.currency,
  });
  if (!settlement.ok) {
    return settlement;
  }
  const written = context.store.commit([...settlement.value.drafts]);
  if (!written.ok) {
    return written;
  }
  return ok({
    qualified: qualified.value,
    clawedBack: clawed.value,
    accrualsPosted: firstAccruals.value + secondAccruals.value,
    settlement: settlement.value,
  });
}

export function positionOf(context: Context, advocate: AdvocateId, currency: Currency) {
  const total = accrualsOfAdvocate(context.store, advocate).reduce(
    (running, row) => running + row.amountMinor,
    0,
  );
  return money(currency, total);
}

export function undatedAccruals(context: Context, advocate: AdvocateId): string[] {
  return accrualsOfAdvocate(context.store, advocate)
    .filter((row) => {
      const on = readDayText(row.postedOn, 'postedOn');
      return !on.ok || on.value === undefined;
    })
    .map((row) => row.id);
}
