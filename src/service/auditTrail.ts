/**
 * The audit trail. The journal already is the audit trail, so nothing here
 * records anything. What it does is answer the questions an auditor actually
 * asks, which are never "what happened" but "why is this number this number".
 *
 * So the entry point is a subject rather than a date range: give it an accrual,
 * a referral or an advocate, and it walks back through the records that produced
 * it and reports them in order with who did each one.
 */

import { formatInstant, type Instant } from '../util/clock.js';
import { ascending, byKey, sorted } from '../util/ordering.js';
import { fail, ok, type Result } from '../util/result.js';
import type { AccrualId, AdvocateId } from '../domain/identity.js';
import { optionalTextField } from '../storage/events.js';
import type { JournalRecord } from '../storage/journal.js';
import type { Context } from './context.js';

export interface TrailEntry {
  readonly sequence: number;
  readonly at: Instant;
  readonly kind: string;
  readonly key: string;
  readonly actor: string;
  readonly digest: string;
}

export function entryOf(record: JournalRecord): TrailEntry {
  return {
    sequence: record.sequence,
    at: record.at,
    kind: record.kind,
    key: record.key,
    actor: optionalTextField(record.payload, 'actor') ?? 'unknown',
    digest: record.digest,
  };
}

function walk(context: Context, keep: (record: JournalRecord) => boolean): TrailEntry[] {
  return sorted(
    context.store.journal.all().filter(keep).map(entryOf),
    byKey((entry: TrailEntry) => entry.sequence, ascending),
  );
}

export function trailForKey(context: Context, key: string): TrailEntry[] {
  return walk(context, (record) => record.key === key);
}

export function trailForAccrual(context: Context, accrual: AccrualId): Result<TrailEntry[]> {
  const row = context.store.accruals.get(accrual);
  if (row === undefined) {
    return fail('audit_accrual_unknown', `no accrual ${accrual}`);
  }
  const referralKey = row.referralKey;
  return ok(
    walk(
      context,
      (record) =>
        record.key === accrual ||
        record.key === referralKey ||
        optionalTextField(record.payload, 'referralKey') === referralKey,
    ),
  );
}

export function trailForAdvocate(context: Context, advocate: AdvocateId): Result<TrailEntry[]> {
  if (context.store.advocates.get(advocate) === undefined) {
    return fail('audit_advocate_unknown', `no advocate ${advocate}`);
  }
  return ok(
    walk(
      context,
      (record) =>
        record.key === advocate || optionalTextField(record.payload, 'advocate') === advocate,
    ),
  );
}

export function actorsIn(entries: readonly TrailEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.actor))].sort();
}

export function kindsIn(entries: readonly TrailEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.kind))].sort();
}

export function describeEntry(entry: TrailEntry): string {
  return `${entry.sequence} ${formatInstant(entry.at)} ${entry.kind} by ${entry.actor}`;
}

/**
 * The journal is only an audit trail if it still verifies. Anything that prints
 * a trail should say whether it does, because a printed trail off an unverified
 * journal is worth exactly nothing.
 */
export function trailIsTrustworthy(context: Context): boolean {
  return context.store.journal.verify().ok;
}
