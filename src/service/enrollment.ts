/**
 * Filing carriers and enrolling advocates.
 *
 * A referral code is minted from the advocate's own identifier rather than
 * drawn at random, so the same advocate enrolled twice on two machines gets the
 * same code and the second enrolment collides on the unique index instead of
 * quietly issuing a second code that half the fuel desks already have.
 */

import { formatDay, type Day } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { codeAlphabet, mintReferralCode } from '../util/ids.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, CarrierId, ProgramId } from '../domain/identity.js';
import { bankDigest, remitDigest, validateParty, type Party } from '../domain/party.js';
import type { JournalDraft } from '../storage/journal.js';
import { advocateById, advocatesOfCarrier, carrierById } from '../storage/repositories.js';
import { isEnrolledRow } from '../storage/rows.js';
import type { Context } from './context.js';

/** Six characters drawn deterministically from the advocate identifier. */
export function codeBodyFor(advocate: AdvocateId): string {
  const alphabet = codeAlphabet();
  const digest = digestOfParts(['referral-code', advocate]);
  let body = '';
  for (let i = 0; i < 6; i += 1) {
    const pair = digest.slice((i * 2) % digest.length, ((i * 2) % digest.length) + 2) || '00';
    const at = (Number.parseInt(pair, 16) + i * 7) % alphabet.length;
    body += alphabet[at] as string;
  }
  return body;
}

export function referralCodeFor(advocate: AdvocateId): Result<string> {
  return mintReferralCode(codeBodyFor(advocate));
}

export function fileCarrier(context: Context, party: Party): Result<JournalDraft[]> {
  const checked = validateParty(party);
  if (!checked.ok) {
    return checked;
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'carrier_filed',
      key: party.id,
      payload: {
        carrier: party.id,
        legalName: party.legalName,
        motorCarrierNumber: party.motorCarrierNumber,
        dotNumber: party.dotNumber,
        authorityStatus: party.authorityStatus,
        remitDigest: remitDigest(party.remit),
        bankDigest: party.bank === undefined ? '' : bankDigest(party.bank),
        powerUnits: party.powerUnits,
        actor: context.actor,
      },
    },
  ]);
}

export interface EnrolmentRequest {
  readonly carrier: CarrierId;
  readonly program: ProgramId;
  readonly from: Day;
}

export function enrolAdvocate(
  context: Context,
  request: EnrolmentRequest,
): Result<{ advocate: AdvocateId; referralCode: string; drafts: JournalDraft[] }> {
  const carrier = carrierById(context.store, request.carrier);
  if (!carrier.ok) {
    return carrier;
  }
  if (carrier.value.authorityStatus !== 'active') {
    return fail(
      'enrolment_authority_not_active',
      `carrier ${request.carrier} is ${carrier.value.authorityStatus}`,
    );
  }
  const already = advocatesOfCarrier(context.store, request.carrier).find(
    (row) => row.program === request.program && isEnrolledRow(row),
  );
  if (already !== undefined) {
    return fail(
      'enrolment_already_open',
      `carrier ${request.carrier} is already enrolled as ${already.id}`,
    );
  }
  const advocate = context.ids.mint('advocate') as AdvocateId;
  const code = referralCodeFor(advocate);
  if (!code.ok) {
    return code;
  }
  return ok({
    advocate,
    referralCode: code.value,
    drafts: [
      {
        at: context.clock.now(),
        kind: 'advocate_enrolled',
        key: advocate,
        payload: {
          advocate,
          carrier: request.carrier,
          program: request.program,
          referralCode: code.value,
          from: formatDay(request.from),
          actor: context.actor,
        },
      },
    ],
  });
}

export function withdrawAdvocate(
  context: Context,
  advocate: AdvocateId,
  until: Day,
  reason: string,
): Result<JournalDraft[]> {
  const row = advocateById(context.store, advocate);
  if (!row.ok) {
    return row;
  }
  if (!isEnrolledRow(row.value)) {
    return fail('enrolment_not_open', `advocate ${advocate} is not enrolled`);
  }
  if (formatDay(until) <= row.value.enrolledFrom) {
    return fail(
      'enrolment_end_before_start',
      'an enrolment cannot end on or before the day it began',
    );
  }
  return ok([
    {
      at: context.clock.now(),
      kind: 'advocate_withdrawn',
      key: advocate,
      payload: { advocate, until: formatDay(until), reason, actor: context.actor },
    },
  ]);
}
