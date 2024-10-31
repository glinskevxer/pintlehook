/**
 * Holds. A settlement batch does not go out while something about the advocate
 * is unresolved, and the rules here read the settlement stream rather than the
 * accrual stream.
 *
 * That is deliberate and it is the last of the composed rules. Nothing below
 * mentions attribution, screening or the cure window, and yet a change to any
 * of them moves the held batch count, because they move what lands in a batch
 * and what the advocate's net position is when the batch is cut.
 */

import type { Day } from '../util/clock.js';
import { isNegative, type Money } from '../util/money.js';
import { sorted, byKey, ascending } from '../util/ordering.js';

export type HoldReason =
  | 'negative_position'
  | 'recovery_over_ceiling'
  | 'eligibility_flag_open'
  | 'no_remit_details'
  | 'below_minimum'
  | 'program_year_cap_reached';

/** Lower sorts first, and the first reason is the one the register prints. */
const REASON_RANK: Record<HoldReason, number> = {
  eligibility_flag_open: 1,
  negative_position: 2,
  recovery_over_ceiling: 3,
  no_remit_details: 4,
  program_year_cap_reached: 5,
  below_minimum: 6,
};

export interface HoldInput {
  readonly netPosition: Money;
  readonly recoveryOutstanding: Money;
  readonly releaseCeiling: Money;
  readonly minimumPayout: Money;
  readonly openEligibilityFlags: readonly string[];
  readonly hasRemitDetails: boolean;
  readonly programYearCapReached: boolean;
  readonly asOf: Day;
}

export interface HoldVerdict {
  readonly held: boolean;
  readonly reasons: readonly HoldReason[];
  readonly primaryReason?: HoldReason | undefined;
}

export function assessHold(input: HoldInput): HoldVerdict {
  const reasons: HoldReason[] = [];
  if (input.openEligibilityFlags.length > 0) {
    reasons.push('eligibility_flag_open');
  }
  if (isNegative(input.netPosition)) {
    reasons.push('negative_position');
  }
  if (input.recoveryOutstanding.minor > input.releaseCeiling.minor) {
    reasons.push('recovery_over_ceiling');
  }
  if (!input.hasRemitDetails) {
    reasons.push('no_remit_details');
  }
  if (input.programYearCapReached) {
    reasons.push('program_year_cap_reached');
  }
  if (
    !isNegative(input.netPosition) &&
    input.netPosition.minor > 0 &&
    input.netPosition.minor < input.minimumPayout.minor
  ) {
    reasons.push('below_minimum');
  }
  const ordered = sorted(
    reasons,
    byKey((reason: HoldReason) => REASON_RANK[reason], ascending),
  );
  return {
    held: ordered.length > 0,
    reasons: ordered,
    primaryReason: ordered[0],
  };
}

export function reasonRank(reason: HoldReason): number {
  return REASON_RANK[reason];
}

/** A hold the settlement desk can lift by hand, against one it cannot. */
export function isReleasable(reason: HoldReason): boolean {
  return reason === 'below_minimum' || reason === 'no_remit_details';
}

export function releasableByHand(verdict: HoldVerdict): boolean {
  return verdict.held && verdict.reasons.every(isReleasable);
}

export function describeHold(verdict: HoldVerdict): string {
  if (!verdict.held) {
    return 'clear to pay';
  }
  return `held on ${verdict.reasons.join(', ')}`;
}
