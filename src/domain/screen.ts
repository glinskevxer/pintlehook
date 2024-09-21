/**
 * The common authority screen. A referral is supposed to bring in a carrier the
 * brokerage did not already have, so a touch is screened out when the advocate
 * and the invitee are plainly the same operation wearing two names.
 *
 * The screen does not drop the referral. It drops the touch, and dropping a
 * touch promotes whatever touch was underneath it, which is how a screening
 * rule ends up deciding who gets paid rather than whether anybody does.
 */

import { digestOfParts } from '../util/digest.js';
import { fail, ok, type Result } from '../util/result.js';
import { normalizeLegalName, remitDigest, bankDigest, type Party } from './party.js';

export type ScreenSignal =
  | 'same_carrier'
  | 'same_authority'
  | 'same_dot'
  | 'same_remit'
  | 'same_bank'
  | 'same_legal_name';

export const SCREEN_SIGNALS: readonly ScreenSignal[] = [
  'same_carrier',
  'same_authority',
  'same_dot',
  'same_remit',
  'same_bank',
  'same_legal_name',
];

/**
 * How much a signal counts. The screen fires at or above the threshold, so a
 * single strong signal is enough and two weak ones are enough together.
 */
const SIGNAL_WEIGHT: Record<ScreenSignal, number> = {
  same_carrier: 100,
  same_authority: 100,
  same_dot: 100,
  same_remit: 60,
  same_bank: 80,
  same_legal_name: 60,
};

export const SCREEN_THRESHOLD = 100;

export interface ScreenVerdict {
  readonly screened: boolean;
  readonly signals: readonly ScreenSignal[];
  readonly score: number;
}

export function signalWeight(signal: ScreenSignal): number {
  return SIGNAL_WEIGHT[signal];
}

export function screenParties(advocate: Party, invitee: Party): ScreenVerdict {
  const signals: ScreenSignal[] = [];
  if (advocate.id === invitee.id) {
    signals.push('same_carrier');
  }
  if (advocate.motorCarrierNumber === invitee.motorCarrierNumber) {
    signals.push('same_authority');
  }
  if (advocate.dotNumber === invitee.dotNumber) {
    signals.push('same_dot');
  }
  if (remitDigest(advocate.remit) === remitDigest(invitee.remit)) {
    signals.push('same_remit');
  }
  if (
    advocate.bank !== undefined &&
    invitee.bank !== undefined &&
    bankDigest(advocate.bank) === bankDigest(invitee.bank)
  ) {
    signals.push('same_bank');
  }
  if (normalizeLegalName(advocate.legalName) === normalizeLegalName(invitee.legalName)) {
    signals.push('same_legal_name');
  }
  const score = signals.reduce((total, signal) => total + SIGNAL_WEIGHT[signal], 0);
  return { screened: score >= SCREEN_THRESHOLD, signals, score };
}

/** A stable key for one screened pair, so the exception report can dedupe. */
export function screenPairKey(advocate: Party, invitee: Party): string {
  const [left, right] = [advocate.id as string, invitee.id as string].sort();
  return digestOfParts([left, right]);
}

export function describeVerdict(verdict: ScreenVerdict): string {
  if (!verdict.screened) {
    return verdict.signals.length === 0
      ? 'no common authority signals'
      : `below threshold at ${verdict.score}: ${verdict.signals.join(', ')}`;
  }
  return `screened at ${verdict.score}: ${verdict.signals.join(', ')}`;
}

export function requireDistinct(advocate: Party, invitee: Party): Result<ScreenVerdict> {
  const verdict = screenParties(advocate, invitee);
  return verdict.screened ? fail('screen_common_authority', describeVerdict(verdict)) : ok(verdict);
}
