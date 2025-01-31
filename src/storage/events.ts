/**
 * The event kinds the journal carries, and the shape of each payload.
 *
 * There is one list and everything reads it. A writer that invents a kind and a
 * reader that has never heard of it is the failure this file exists to make
 * impossible, so an unknown kind is an error at fold time rather than a record
 * that quietly does nothing.
 */

import { fail, ok, type Result } from '../util/result.js';
import type { JournalPayload, JournalRecord } from './journal.js';

export const EVENT_KINDS = [
  'carrier_filed',
  'advocate_enrolled',
  'advocate_withdrawn',
  'touch_recorded',
  'referral_opened',
  'referral_attributed',
  'referral_qualified',
  'referral_reversed',
  'load_delivered',
  'load_amended',
  'claim_stated',
  'accrual_posted',
  'batch_cut',
  'batch_released',
  'batch_paid',
  'eligibility_flag_raised',
  'eligibility_flag_cleared',
  'program_version_added',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const REQUIRED_FIELDS: Record<EventKind, readonly string[]> = {
  carrier_filed: ['carrier', 'legalName', 'motorCarrierNumber'],
  advocate_enrolled: ['advocate', 'carrier', 'program', 'referralCode', 'from'],
  advocate_withdrawn: ['advocate', 'until', 'reason'],
  touch_recorded: ['touch', 'advocate', 'invitee', 'channel', 'at'],
  referral_opened: ['program', 'invitee', 'recordedOn'],
  referral_attributed: ['program', 'invitee', 'advocate', 'effectiveActivation'],
  referral_qualified: ['program', 'invitee', 'qualifiedOn'],
  referral_reversed: ['program', 'invitee', 'reversedOn', 'reason'],
  load_delivered: ['load', 'carrier', 'proNumber', 'deliveredOn'],
  load_amended: ['load', 'field'],
  claim_stated: ['claim', 'load', 'disposition', 'amountMinor'],
  accrual_posted: ['accrual', 'advocate', 'referralKey', 'kind', 'amountMinor', 'postedOn'],
  batch_cut: ['batch', 'periodFrom', 'periodUntil'],
  batch_released: ['batch', 'releasedOn'],
  batch_paid: ['batch', 'paidOn'],
  eligibility_flag_raised: ['advocate', 'flag', 'raisedOn'],
  eligibility_flag_cleared: ['advocate', 'flag', 'clearedOn'],
  program_version_added: ['program', 'version', 'effectiveFrom'],
};

export function isEventKind(value: string): value is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(value);
}

export function requiredFields(kind: EventKind): readonly string[] {
  return REQUIRED_FIELDS[kind];
}

export function checkPayload(kind: EventKind, payload: JournalPayload): Result<JournalPayload> {
  const missing = requiredFields(kind).filter(
    (field) => payload[field] === undefined || payload[field] === null,
  );
  if (missing.length > 0) {
    return fail('event_payload_incomplete', `a ${kind} needs ${missing.join(', ')}`);
  }
  return ok(payload);
}

export function readEvent(
  record: JournalRecord,
): Result<{ kind: EventKind; payload: JournalPayload }> {
  if (!isEventKind(record.kind)) {
    return fail(
      'event_kind_unknown',
      `record ${record.sequence} carries an unknown kind "${record.kind}"`,
    );
  }
  const checked = checkPayload(record.kind, record.payload);
  return checked.ok ? ok({ kind: record.kind, payload: checked.value }) : checked;
}

/** Read a field out of a payload with the type the caller expects. */
export function textField(payload: JournalPayload, field: string): Result<string> {
  const value = payload[field];
  return typeof value === 'string'
    ? ok(value)
    : fail('event_field_not_text', `${field} is not text`);
}

export function numberField(payload: JournalPayload, field: string): Result<number> {
  const value = payload[field];
  return typeof value === 'number' && Number.isFinite(value)
    ? ok(value)
    : fail('event_field_not_number', `${field} is not a number`);
}

export function booleanField(payload: JournalPayload, field: string): Result<boolean> {
  const value = payload[field];
  return typeof value === 'boolean'
    ? ok(value)
    : fail('event_field_not_boolean', `${field} is not a boolean`);
}

export function optionalTextField(payload: JournalPayload, field: string): string | undefined {
  const value = payload[field];
  return typeof value === 'string' ? value : undefined;
}
