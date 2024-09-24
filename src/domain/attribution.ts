/**
 * Attribution. The window runs backwards from effective activation, the latest
 * surviving touch inside it wins, and the screen removes touches before the
 * winner is picked rather than after.
 *
 * The order matters more than it looks. Screening after the pick would mean a
 * screened winner voids the referral. Screening before the pick means a
 * screened winner promotes the touch underneath it, so the referral still pays,
 * to somebody else. The second is what the program intends, and it is why a
 * change to the screen moves money between advocates rather than out of the
 * program.
 */

import { localDayOf, type ZoneId } from '../util/zoned.js';
import { contains, windowEndingOn, type DayInterval } from '../util/interval.js';
import { sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { Day } from '../util/clock.js';
import type { AdvocateId } from './identity.js';
import { touchOrder, type ReferralTouch } from './touch.js';
import type { ScreenVerdict } from './screen.js';

export interface ScreenedTouch {
  readonly touch: ReferralTouch;
  readonly verdict: ScreenVerdict;
}

export type AttributionOutcome =
  | {
      readonly credited: true;
      readonly advocate: AdvocateId;
      readonly winningTouch: ReferralTouch;
      readonly window: DayInterval;
      readonly considered: readonly ReferralTouch[];
      readonly screened: readonly ScreenedTouch[];
      readonly outsideWindow: readonly ReferralTouch[];
    }
  | {
      readonly credited: false;
      readonly reason: UncreditedReason;
      readonly window: DayInterval;
      readonly considered: readonly ReferralTouch[];
      readonly screened: readonly ScreenedTouch[];
      readonly outsideWindow: readonly ReferralTouch[];
    };

export type UncreditedReason = 'no_touches' | 'all_outside_window' | 'all_screened';

export interface AttributionInput {
  readonly touches: readonly ReferralTouch[];
  readonly effectiveActivation: Day;
  readonly attributionWindowDays: number;
  readonly zone: ZoneId;
  /** Returns a verdict for a touch, or nothing when the pair cannot be read. */
  readonly screen: (touch: ReferralTouch) => ScreenVerdict | undefined;
}

export function attributionWindow(effectiveActivation: Day, days: number): Result<DayInterval> {
  if (!Number.isInteger(days) || days <= 0) {
    return fail(
      'attribution_window_length',
      'the attribution window must be a positive whole number of days',
    );
  }
  return ok(windowEndingOn(effectiveActivation, days));
}

export function touchDay(touch: ReferralTouch, zone: ZoneId): Day {
  return localDayOf(zone, touch.at);
}

export function resolveAttribution(input: AttributionInput): Result<AttributionOutcome> {
  const window = attributionWindow(input.effectiveActivation, input.attributionWindowDays);
  if (!window.ok) {
    return window;
  }
  const inside: ReferralTouch[] = [];
  const outsideWindow: ReferralTouch[] = [];
  for (const touch of input.touches) {
    if (contains(window.value, touchDay(touch, input.zone))) {
      inside.push(touch);
    } else {
      outsideWindow.push(touch);
    }
  }
  const screened: ScreenedTouch[] = [];
  const surviving: ReferralTouch[] = [];
  for (const touch of inside) {
    const verdict = input.screen(touch);
    if (verdict !== undefined && verdict.screened) {
      screened.push({ touch, verdict });
    } else {
      surviving.push(touch);
    }
  }
  const shared = {
    window: window.value,
    considered: inside,
    screened,
    outsideWindow,
  } as const;
  if (input.touches.length === 0) {
    return ok({ credited: false, reason: 'no_touches', ...shared });
  }
  if (inside.length === 0) {
    return ok({ credited: false, reason: 'all_outside_window', ...shared });
  }
  const winner = sorted(surviving, touchOrder).at(-1);
  if (winner === undefined) {
    return ok({ credited: false, reason: 'all_screened', ...shared });
  }
  return ok({ credited: true, advocate: winner.advocate, winningTouch: winner, ...shared });
}

export function creditedAdvocate(outcome: AttributionOutcome): AdvocateId | undefined {
  return outcome.credited ? outcome.advocate : undefined;
}

export function describeAttribution(outcome: AttributionOutcome): string {
  if (outcome.credited) {
    const channel = outcome.winningTouch.channel;
    return `credited to ${outcome.advocate} on a ${channel} touch`;
  }
  return `uncredited: ${outcome.reason}`;
}
