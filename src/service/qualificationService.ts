/**
 * Qualification over the store. Reads the invited carrier's loads, asks the
 * domain rule, and writes the qualification when it is met.
 *
 * The margin it reports is the margin of every counting load, not only the
 * first n. A tier with a margin share is a share of what the referral actually
 * produced inside the window, and stopping at the qualifying load would pay a
 * carrier who ran six loads the same as one who ran sixty.
 */

import { formatDay, type Day } from '../util/clock.js';
import type { Currency, Money } from '../util/money.js';
import { fail, ok, type Result } from '../util/result.js';
import type { CarrierId, LoadId, ProgramId } from '../domain/identity.js';
import type { Lane, Load, LoadStatus } from '../domain/load.js';
import { resolveQualification, type QualificationOutcome } from '../domain/qualification.js';
import type { JournalDraft } from '../storage/journal.js';
import { loadsOfCarrier, referralByKey } from '../storage/repositories.js';
import { readDayText, type LoadRow } from '../storage/rows.js';
import { referralKeyOf } from '../storage/store.js';
import { rulesFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';

export function loadOf(row: LoadRow): Result<Load> {
  const deliveredOn = readDayText(row.deliveredOn, 'deliveredOn');
  if (!deliveredOn.ok) {
    return deliveredOn;
  }
  const lane: Lane = { originState: row.originState, destinationState: row.destinationState };
  return ok({
    id: row.id as LoadId,
    carrier: row.carrier as CarrierId,
    status: row.status as LoadStatus,
    deliveredOn: deliveredOn.value,
    billedOn: undefined,
    lane,
    lineHaulMinor: row.lineHaulMinor,
    carrierPayMinor: row.carrierPayMinor,
    currency: row.currency as Currency,
    proNumber: row.proNumber,
  });
}

/**
 * Every load on file for a carrier, read back into domain values.
 *
 * Three callers were writing this loop, and they had drifted: one skipped a
 * load that was not delivered and the other two kept it, so the same carrier
 * had a different lane count depending on which report asked. One reader, and
 * the filtering is the caller's business.
 */
export function loadsOf(context: Context, carrier: CarrierId): Result<Load[]> {
  const loads: Load[] = [];
  for (const row of loadsOfCarrier(context.store, carrier)) {
    const load = loadOf(row);
    if (!load.ok) {
      return load;
    }
    loads.push(load.value);
  }
  return ok(loads);
}

export function deliveredLoadsOf(context: Context, carrier: CarrierId): Result<Load[]> {
  const loads = loadsOf(context, carrier);
  return loads.ok ? ok(loads.value.filter((load) => load.status === 'delivered')) : loads;
}

export interface QualificationRequest {
  readonly program: ProgramId;
  readonly invitee: CarrierId;
  readonly effectiveActivation: Day;
}

export function qualifyReferral(
  context: Context,
  catalog: Catalog,
  request: QualificationRequest,
): Result<QualificationOutcome> {
  const rules = rulesFor(catalog, request.program, request.effectiveActivation);
  if (!rules.ok) {
    return rules;
  }
  const loads = loadsOf(context, request.invitee);
  if (!loads.ok) {
    return loads;
  }
  return resolveQualification({
    loads: loads.value,
    effectiveActivation: request.effectiveActivation,
    qualifyingLoadCount: rules.value.qualifyingLoadCount,
    qualifyingWindowDays: rules.value.qualifyingWindowDays,
    currency: rules.value.currency,
  });
}

export function qualificationDrafts(
  context: Context,
  request: QualificationRequest,
  outcome: QualificationOutcome,
): Result<JournalDraft[]> {
  if (!outcome.qualified) {
    return fail('qualification_not_met', `the referral is short by ${outcome.shortBy} loads`);
  }
  const referral = referralByKey(context.store, request.program, request.invitee);
  if (!referral.ok) {
    return referral;
  }
  if (referral.value.advocate === '') {
    return fail('qualification_unattributed', 'an unattributed referral cannot qualify');
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'referral_qualified',
      key: referralKeyOf(request.program, request.invitee),
      payload: {
        program: request.program,
        invitee: request.invitee,
        qualifiedOn: formatDay(outcome.qualifiedOn),
        qualifyingLoad: outcome.qualifyingLoad.id,
        deliveredMarginMinor: outcome.deliveredMargin.minor,
        loadCount: outcome.countingLoads.length,
        actor: context.actor,
      },
    },
  ]);
}

export function deliveredMarginOf(outcome: QualificationOutcome): Money {
  return outcome.deliveredMargin;
}

export function shortfallOf(outcome: QualificationOutcome): number {
  return outcome.qualified ? 0 : outcome.shortBy;
}
