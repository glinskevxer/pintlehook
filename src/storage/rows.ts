/**
 * The projection rows. A fold over the journal writes these, and every read
 * model is built from them.
 *
 * They are flat and they hold days as text, because a row goes into a snapshot
 * as json and a shape that survives that trip without a codec is a shape that
 * cannot drift from the one the codec expected.
 */

import { formatDay, parseDay, type Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';

export interface CarrierRow {
  readonly id: string;
  readonly legalName: string;
  readonly motorCarrierNumber: string;
  readonly dotNumber: string;
  readonly authorityStatus: string;
  readonly remitDigest: string;
  readonly bankDigest: string;
  readonly powerUnits: number;
}

export interface AdvocateRow {
  readonly id: string;
  readonly carrier: string;
  readonly program: string;
  readonly referralCode: string;
  readonly enrolledFrom: string;
  readonly enrolledUntil: string;
  readonly endReason: string;
}

export interface TouchRow {
  readonly id: string;
  readonly advocate: string;
  readonly invitee: string;
  readonly channel: string;
  readonly presentedCode: string;
  readonly at: number;
  readonly sourceReference: string;
}

export interface ReferralRow {
  readonly key: string;
  readonly program: string;
  readonly invitee: string;
  readonly advocate: string;
  readonly state: string;
  readonly recordedOn: string;
  readonly effectiveActivation: string;
  readonly qualifiedOn: string;
  readonly reversedOn: string;
}

export interface LoadRow {
  readonly id: string;
  readonly carrier: string;
  readonly proNumber: string;
  readonly status: string;
  readonly deliveredOn: string;
  readonly lineHaulMinor: number;
  readonly carrierPayMinor: number;
  readonly currency: string;
  readonly originState: string;
  readonly destinationState: string;
}

export interface ClaimRow {
  readonly id: string;
  readonly load: string;
  readonly raisedOn: string;
  readonly disposition: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface AccrualRow {
  readonly id: string;
  readonly advocate: string;
  readonly program: string;
  readonly referralKey: string;
  readonly kind: string;
  readonly postedOn: string;
  readonly programYearFrom: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reverses: string;
  readonly note: string;
}

export interface BatchRow {
  readonly id: string;
  readonly periodFrom: string;
  readonly periodUntil: string;
  readonly cutOn: string;
  readonly state: string;
  readonly currency: string;
}

export interface FlagRow {
  readonly key: string;
  readonly advocate: string;
  readonly flag: string;
  readonly raisedOn: string;
  readonly clearedOn: string;
}

export const NO_DAY = '';

export function dayText(value: Day | undefined): string {
  return value === undefined ? NO_DAY : formatDay(value);
}

export function readDayText(text: string, field: string): Result<Day | undefined> {
  if (text === NO_DAY) {
    return ok(undefined);
  }
  const parsed = parseDay(text);
  return parsed.ok ? ok(parsed.value) : fail('row_day_unreadable', `${field} reads "${text}"`);
}

export function requireDayText(text: string, field: string): Result<Day> {
  const parsed = readDayText(text, field);
  if (!parsed.ok) {
    return parsed;
  }
  return parsed.value === undefined
    ? fail('row_day_missing', `${field} is empty`)
    : ok(parsed.value);
}

export function flagKey(advocate: string, flag: string): string {
  return `${advocate}:${flag}`;
}

export function isOpenFlag(row: FlagRow): boolean {
  return row.clearedOn === NO_DAY;
}

export function isEnrolledRow(row: AdvocateRow): boolean {
  return row.enrolledUntil === NO_DAY;
}

export const TABLE_NAMES = [
  'carriers',
  'advocates',
  'touches',
  'referrals',
  'loads',
  'claims',
  'accruals',
  'batches',
  'flags',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];
