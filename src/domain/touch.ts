/**
 * A referral touch is one moment where an invited carrier came into contact
 * with an advocate's referral code. Touches arrive from four channels and the
 * channels do not agree on what they can prove, which is why a touch carries a
 * strength rather than being simply present or absent.
 */

import type { Instant } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { ascending, byKey, chain, byText } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { Comparator } from '../util/ordering.js';
import type { AdvocateId, CarrierId, TouchId } from './identity.js';

/**
 * card: a fuel desk card handed over in person and typed at the counter
 * link: a tracked link the invited carrier followed
 * verbal: a name given to a recruiter over the phone
 * packet: the referral field on the carrier packet itself
 */
export type TouchChannel = 'card' | 'link' | 'verbal' | 'packet';

export const TOUCH_CHANNELS: readonly TouchChannel[] = ['card', 'link', 'verbal', 'packet'];

/**
 * Strength is how much the channel can prove, and it breaks ties between two
 * touches that carry the same instant. A packet field is the carrier's own
 * signed statement, so it outranks a recruiter's note of a phone call.
 */
const CHANNEL_STRENGTH: Record<TouchChannel, number> = {
  packet: 4,
  card: 3,
  link: 2,
  verbal: 1,
};

export interface ReferralTouch {
  readonly id: TouchId;
  readonly advocate: AdvocateId;
  readonly invitee: CarrierId;
  readonly channel: TouchChannel;
  readonly presentedCode: string;
  readonly at: Instant;
  readonly sourceReference: string;
  /** Set when the feed that produced the touch could not prove the invitee. */
  readonly inviteeInferred: boolean;
}

export function isTouchChannel(value: string): value is TouchChannel {
  return (TOUCH_CHANNELS as readonly string[]).includes(value);
}

export function parseTouchChannel(value: string): Result<TouchChannel> {
  const lower = value.trim().toLowerCase();
  return isTouchChannel(lower)
    ? ok(lower)
    : fail('touch_channel_unknown', `no such channel "${value}"`);
}

export function channelStrength(channel: TouchChannel): number {
  return CHANNEL_STRENGTH[channel];
}

/**
 * The order attribution reads: latest instant first when reversed, and where
 * two touches share an instant the stronger channel wins, and where the channel
 * ties as well the identifier decides so that the answer never depends on the
 * order the feed happened to list them in.
 */
export const touchOrder: Comparator<ReferralTouch> = chain(
  byKey((t: ReferralTouch) => t.at, ascending),
  byKey((t: ReferralTouch) => channelStrength(t.channel), ascending),
  byKey((t: ReferralTouch) => t.id as string, byText),
);

/**
 * The natural key of a touch. Two rows that agree on all of it are the same
 * touch arriving twice, whatever identifiers the feeds put on them.
 */
export function touchNaturalKey(touch: ReferralTouch): string {
  return digestOfParts([
    touch.advocate,
    touch.invitee,
    touch.channel,
    touch.presentedCode,
    touch.at,
  ]);
}

export function isSelfTouch(touch: ReferralTouch, advocateCarrier: CarrierId): boolean {
  return touch.invitee === advocateCarrier;
}

export function validateTouch(touch: ReferralTouch): Result<ReferralTouch> {
  if (touch.presentedCode.trim() === '') {
    return fail('touch_code_missing', 'a touch has to carry the code that was presented');
  }
  if (!Number.isFinite(touch.at)) {
    return fail('touch_instant_missing', 'a touch has to carry the instant it happened');
  }
  if (touch.sourceReference.trim() === '') {
    return fail('touch_source_missing', 'a touch has to name the feed row it came from');
  }
  return ok(touch);
}

export function describeTouch(touch: ReferralTouch): string {
  const inferred = touch.inviteeInferred ? ', invitee inferred' : '';
  return `${touch.channel} touch on ${touch.presentedCode} by ${touch.advocate}${inferred}`;
}
