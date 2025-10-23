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
import { NO_DAY, readDayText, requireDayText, type ReferralRow } from '../storage/rows.js';
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

/**
 * A referral row read back into the two things every pass needs from it: the
 * days it carries, and the margin behind it. Three passes were each doing this
 * in five lines, and one of them was reading the activation day out of the row
 * while another recomputed it, which is exactly how two passes end up
 * disagreeing about the same referral.
 */
export interface ReferralFacts {
  readonly key: string;
  readonly invitee: CarrierId;
  readonly effectiveActivation: Day;
  readonly qualifiedOn?: Day | undefined;
  readonly margin: ReturnType<typeof money>;
}

export function factsOf(
  context: Context,
  catalog: Catalog,
  row: ReferralRow,
): Result<ReferralFacts> {
  const activation = requireDayText(row.effectiveActivation, 'effectiveActivation');
  if (!activation.ok) {
    return activation;
  }
  const margin = qualifyReferral(context, catalog, {
    program: row.program as ProgramId,
    invitee: row.invitee as CarrierId,
    effectiveActivation: activation.value,
  });
  if (!margin.ok) {
    return margin;
  }
  let qualifiedOn: Day | undefined;
  if (row.qualifiedOn !== NO_DAY) {
    const read = requireDayText(row.qualifiedOn, 'qualifiedOn');
    if (!read.ok) {
      return read;
    }
    qualifiedOn = read.value;
  }
  return ok({
    key: row.key,
    invitee: row.invitee as CarrierId,
    effectiveActivation: activation.value,
    qualifiedOn,
    margin: margin.value.deliveredMargin,
  });
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
    const facts = factsOf(context, catalog, row);
    if (!facts.ok) {
      return facts;
    }
    if (facts.value.qualifiedOn === undefined) {
      continue;
    }
    const request = {
      program,
      invitee: facts.value.invitee,
      qualifiedOn: facts.value.qualifiedOn,
      deliveredMargin: facts.value.margin,
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
    const facts = factsOf(context, catalog, row);
    if (!facts.ok) {
      return facts;
    }
    const qualifiedOn = facts.value.qualifiedOn;
    if (
      qualifiedOn === undefined ||
      compareDays(qualifiedOn, programYear.from) < 0 ||
      compareDays(qualifiedOn, programYear.until) >= 0
    ) {
      continue;
    }
    found.push({ referralKey: row.key, qualifiedOn, margin: facts.value.margin });
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
    programYearFrom: request.programYearFrom,
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
