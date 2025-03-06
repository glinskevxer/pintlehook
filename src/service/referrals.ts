/**
 * Recording touches and opening referrals.
 *
 * A touch does not open a referral on its own. The referral is opened by the
 * first touch that names an invitee we have a file on, and it is opened against
 * the program the advocate is enrolled in, so a touch presenting a code from a
 * closed program is filed and does nothing.
 */

import { formatDay } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AdvocateId, CarrierId, TouchId } from '../domain/identity.js';
import { parseTouchChannel, type TouchChannel } from '../domain/touch.js';
import type { TouchDraft } from '../ingest/touchFeed.js';
import type { JournalDraft } from '../storage/journal.js';
import { advocateByCode, referralByKey, touchesForInvitee } from '../storage/repositories.js';
import { isEnrolledRow } from '../storage/rows.js';
import { referralKeyOf } from '../storage/store.js';
import type { Context } from './context.js';
import { isInferred, resolveCarrier } from './resolution.js';

export interface RecordedTouch {
  readonly touch: TouchId;
  readonly advocate: AdvocateId;
  readonly invitee: CarrierId;
  readonly channel: TouchChannel;
  readonly openedReferral: boolean;
  readonly inviteeInferred: boolean;
  readonly drafts: readonly JournalDraft[];
}

export function recordTouch(context: Context, draft: TouchDraft): Result<RecordedTouch> {
  const advocate = advocateByCode(context.store, draft.presentedCode);
  if (!advocate.ok) {
    return advocate;
  }
  if (!isEnrolledRow(advocate.value)) {
    return fail(
      'touch_advocate_not_enrolled',
      `code ${draft.presentedCode} belongs to a closed enrolment`,
    );
  }
  const channel = parseTouchChannel(draft.channel);
  if (!channel.ok) {
    return channel;
  }
  const resolved = resolveCarrier(context.store, {
    motorCarrierNumber: draft.inviteeMotorCarrierNumber,
    dotNumber: draft.inviteeDotNumber,
    legalName: draft.inviteeName,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const invitee = resolved.value.carrier.id as CarrierId;
  if (invitee === advocate.value.carrier) {
    return fail('touch_self_referral', 'a carrier cannot present their own referral code');
  }
  const touch = context.ids.mint('touch') as TouchId;
  const program = advocate.value.program;
  const drafts: JournalDraft[] = [
    {
      at: context.clock.now(),
      kind: 'touch_recorded',
      key: touch,
      payload: {
        touch,
        advocate: advocate.value.id,
        invitee,
        channel: channel.value,
        presentedCode: draft.presentedCode,
        at: draft.at,
        sourceReference: draft.sourceReference,
        inviteeInferred: isInferred(resolved.value.basis),
        actor: context.actor,
      },
    },
  ];
  const existing = referralByKey(context.store, program, invitee);
  let openedReferral = false;
  if (!existing.ok) {
    openedReferral = true;
    drafts.push({
      at: context.clock.now(),
      kind: 'referral_opened',
      key: referralKeyOf(program, invitee),
      payload: {
        program,
        invitee,
        recordedOn: formatDay(context.clock.today()),
        actor: context.actor,
      },
    });
  }
  return ok({
    touch,
    advocate: advocate.value.id as AdvocateId,
    invitee,
    channel: channel.value,
    openedReferral,
    inviteeInferred: isInferred(resolved.value.basis),
    drafts,
  });
}

export interface TouchBatchOutcome {
  readonly recorded: readonly RecordedTouch[];
  readonly rejected: readonly { draft: TouchDraft; code: string; message: string }[];
  readonly drafts: readonly JournalDraft[];
}

export function recordTouches(context: Context, drafts: readonly TouchDraft[]): TouchBatchOutcome {
  const recorded: RecordedTouch[] = [];
  const rejected: { draft: TouchDraft; code: string; message: string }[] = [];
  const journal: JournalDraft[] = [];
  for (const draft of drafts) {
    const one = recordTouch(context, draft);
    if (one.ok) {
      recorded.push(one.value);
      journal.push(...one.value.drafts);
    } else {
      const first = one.problems[0];
      rejected.push({
        draft,
        code: first?.code ?? 'touch_rejected',
        message: first?.message ?? 'this touch could not be recorded',
      });
    }
  }
  return { recorded, rejected, drafts: journal };
}

export function touchCountFor(context: Context, invitee: CarrierId): number {
  return touchesForInvitee(context.store, invitee).length;
}
