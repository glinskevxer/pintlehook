/**
 * Attribution over the store. This is where the four pure rules are finally
 * pointed at real rows: the touches on file for the invitee, the screen against
 * the carrier files behind each advocate, the window from the program version
 * in force on the effective activation day, and the terminal zone.
 *
 * Note which day the program version is read on. It is the effective activation
 * day, which the cure rule decided, so a change to the cure window can change
 * which program version supplies the attribution window. That is two rules
 * deep and it is deliberate.
 */

import { formatDay, type Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, CarrierId, ProgramId, TouchId } from '../domain/identity.js';
import {
  resolveAttribution,
  type AttributionOutcome,
  type ScreenedTouch,
} from '../domain/attribution.js';
import { screenParties, type ScreenVerdict } from '../domain/screen.js';
import type { Party } from '../domain/party.js';
import type { ReferralTouch, TouchChannel } from '../domain/touch.js';
import type { JournalDraft } from '../storage/journal.js';
import { advocateById, carrierById, touchesForInvitee } from '../storage/repositories.js';
import type { CarrierRow, TouchRow } from '../storage/rows.js';
import { referralKeyOf } from '../storage/store.js';
import { rulesFor, type Catalog } from './catalog.js';
import type { Context } from './context.js';

/** The screen needs Party shaped values, and the store holds digests. */
function partyOf(row: CarrierRow): Party {
  return {
    id: row.id as CarrierId,
    legalName: row.legalName,
    motorCarrierNumber: row.motorCarrierNumber,
    dotNumber: row.dotNumber,
    authorityStatus: 'unknown',
    remit: { line1: row.remitDigest, city: '', state: 'XX', postalCode: '00000' },
    bank:
      row.bankDigest === ''
        ? undefined
        : { routingDigest: row.bankDigest, accountDigest: row.bankDigest },
    powerUnits: row.powerUnits,
  };
}

function touchOf(row: TouchRow): ReferralTouch {
  return {
    id: row.id as TouchId,
    advocate: row.advocate as AdvocateId,
    invitee: row.invitee as CarrierId,
    channel: row.channel as TouchChannel,
    presentedCode: row.presentedCode,
    at: row.at,
    sourceReference: row.sourceReference,
    inviteeInferred: false,
  };
}

export function screenFor(context: Context, invitee: CarrierId) {
  return (touch: ReferralTouch): ScreenVerdict | undefined => {
    const advocate = advocateById(context.store, touch.advocate);
    if (!advocate.ok) {
      return undefined;
    }
    const advocateCarrier = carrierById(context.store, advocate.value.carrier);
    const inviteeCarrier = carrierById(context.store, invitee);
    if (!advocateCarrier.ok || !inviteeCarrier.ok) {
      return undefined;
    }
    return screenParties(partyOf(advocateCarrier.value), partyOf(inviteeCarrier.value));
  };
}

export interface AttributionRequest {
  readonly program: ProgramId;
  readonly invitee: CarrierId;
  readonly effectiveActivation: Day;
}

export function attributeReferral(
  context: Context,
  catalog: Catalog,
  request: AttributionRequest,
): Result<AttributionOutcome> {
  const rules = rulesFor(catalog, request.program, request.effectiveActivation);
  if (!rules.ok) {
    return rules;
  }
  const touches = touchesForInvitee(context.store, request.invitee).map(touchOf);
  return resolveAttribution({
    touches,
    effectiveActivation: request.effectiveActivation,
    attributionWindowDays: rules.value.attributionWindowDays,
    zone: context.zone,
    screen: screenFor(context, request.invitee),
  });
}

export function attributionDrafts(
  context: Context,
  request: AttributionRequest,
  outcome: AttributionOutcome,
): Result<JournalDraft[]> {
  if (!outcome.credited) {
    return fail('attribution_uncredited', `nothing to credit: ${outcome.reason}`);
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'referral_attributed',
      key: referralKeyOf(request.program, request.invitee),
      payload: {
        program: request.program,
        invitee: request.invitee,
        advocate: outcome.advocate,
        effectiveActivation: formatDay(request.effectiveActivation),
        winningTouch: outcome.winningTouch.id,
        channel: outcome.winningTouch.channel,
        actor: context.actor,
      },
    },
  ]);
}

export function screenedTouchIds(outcome: AttributionOutcome): string[] {
  return outcome.screened.map((screened: ScreenedTouch) => screened.touch.id as string);
}

export function consideredCount(outcome: AttributionOutcome): number {
  return outcome.considered.length;
}
