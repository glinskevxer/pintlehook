/**
 * Clawback. Two things take a bounty back: the invited carrier failing the
 * retention window, and a cargo claim being charged back against the loads that
 * qualified the referral.
 *
 * The claim rule is not a simple flag. A claim only claws back when it is
 * charged to the carrier rather than absorbed, when it lands inside the
 * retention window, and when what it took off the delivered margin is more than
 * the program is willing to leave paid. So the same claim can be a clawback on
 * one referral and a note on the file for another.
 */

import { compareDays, type Day } from '../util/clock.js';
import { contains, type DayInterval } from '../util/interval.js';
import { money, subtract, sum, type Currency, type Money } from '../util/money.js';
import { applyRate, type BasisPoints } from '../util/rate.js';
import { ascending, byKey, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { ClaimId, LoadId } from './identity.js';

export type ClaimDisposition = 'charged_to_carrier' | 'absorbed' | 'denied' | 'open';

export interface CargoClaim {
  readonly id: ClaimId;
  readonly load: LoadId;
  readonly raisedOn: Day;
  readonly disposition: ClaimDisposition;
  readonly amountMinor: number;
  readonly currency: Currency;
}

export type ClawbackReason =
  | 'retention_failed'
  | 'claim_chargeback'
  | 'authority_revoked'
  | 'duplicate_referral'
  | 'manual';

export interface ClawbackPolicy {
  /** Share of the delivered margin a chargeback may eat before it claws back. */
  readonly claimToleranceShare: BasisPoints;
  readonly retentionWindow: DayInterval;
  readonly currency: Currency;
}

export interface ClawbackInput {
  readonly claims: readonly CargoClaim[];
  readonly deliveredMargin: Money;
  readonly retentionFailedOn?: Day | undefined;
  readonly policy: ClawbackPolicy;
}

export interface ClawbackOutcome {
  readonly clawed: boolean;
  readonly reason?: ClawbackReason | undefined;
  readonly on?: Day | undefined;
  readonly chargedClaims: readonly CargoClaim[];
  readonly chargedTotal: Money;
  readonly tolerance: Money;
  readonly marginAfterClaims: Money;
}

export function isChargedBack(claim: CargoClaim, window: DayInterval): boolean {
  return claim.disposition === 'charged_to_carrier' && contains(window, claim.raisedOn);
}

export function assessClawback(input: ClawbackInput): Result<ClawbackOutcome> {
  const currency = input.policy.currency;
  if (input.deliveredMargin.currency !== currency) {
    return fail(
      'clawback_currency_mismatch',
      `margin is ${input.deliveredMargin.currency} against a policy in ${currency}`,
    );
  }
  const foreign = input.claims.find((claim) => claim.currency !== currency);
  if (foreign !== undefined) {
    return fail(
      'clawback_currency_mismatch',
      `claim ${foreign.id} is in ${foreign.currency} against a policy in ${currency}`,
    );
  }
  const charged = sorted(
    input.claims.filter((claim) => isChargedBack(claim, input.policy.retentionWindow)),
    byKey((claim: CargoClaim) => claim.raisedOn, compareDays),
  );
  const chargedTotal = sum(
    charged.map((claim) => money(currency, claim.amountMinor)),
    currency,
  );
  const tolerance = applyRate(input.deliveredMargin, input.policy.claimToleranceShare);
  const marginAfterClaims = subtract(input.deliveredMargin, chargedTotal);
  const shared = { chargedClaims: charged, chargedTotal, tolerance, marginAfterClaims } as const;

  const claimBreachOn = firstDayTheToleranceIsBreached(charged, tolerance, currency);
  const retentionOn = input.retentionFailedOn;
  if (retentionOn !== undefined && claimBreachOn !== undefined) {
    return compareDays(retentionOn, claimBreachOn) <= 0
      ? ok({ clawed: true, reason: 'retention_failed', on: retentionOn, ...shared })
      : ok({ clawed: true, reason: 'claim_chargeback', on: claimBreachOn, ...shared });
  }
  if (retentionOn !== undefined) {
    return ok({ clawed: true, reason: 'retention_failed', on: retentionOn, ...shared });
  }
  if (claimBreachOn !== undefined) {
    return ok({ clawed: true, reason: 'claim_chargeback', on: claimBreachOn, ...shared });
  }
  return ok({ clawed: false, ...shared });
}

/**
 * Claims are applied in the order they were raised, and the clawback is dated
 * to the claim that took the running total past the tolerance rather than to
 * the last claim on the file.
 */
function firstDayTheToleranceIsBreached(
  charged: readonly CargoClaim[],
  tolerance: Money,
  currency: Currency,
): Day | undefined {
  let running = 0;
  for (const claim of charged) {
    running += claim.amountMinor;
    if (money(currency, running).minor > tolerance.minor) {
      return claim.raisedOn;
    }
  }
  return undefined;
}

export function claimOrder(claims: readonly CargoClaim[]): CargoClaim[] {
  return sorted(
    claims,
    byKey((claim: CargoClaim) => claim.amountMinor, ascending),
  );
}

export function describeClawback(outcome: ClawbackOutcome): string {
  if (!outcome.clawed) {
    return 'no clawback';
  }
  return `clawed back for ${outcome.reason ?? 'unknown'}`;
}
