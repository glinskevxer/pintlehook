/**
 * The journal record. Everything this program knows is a fold over an append
 * only list of these, and nothing else is authoritative.
 *
 * Each record carries the digest of the record before it, so a journal that has
 * been edited in the middle stops verifying at the edit rather than at the end.
 * That is worth more than it costs: the settlement register is defended by the
 * journal, and a journal nobody can check is not a defence.
 */

import type { Instant } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { fail, ok, type Result } from '../util/result.js';

export const GENESIS_DIGEST = '00000000';

export type JournalPayload = Readonly<Record<string, unknown>>;

export interface JournalRecord {
  readonly sequence: number;
  readonly at: Instant;
  readonly kind: string;
  readonly key: string;
  readonly payload: JournalPayload;
  readonly previousDigest: string;
  readonly digest: string;
}

export interface JournalDraft {
  readonly at: Instant;
  readonly kind: string;
  readonly key: string;
  readonly payload: JournalPayload;
}

/**
 * The bytes a digest is taken over. Keys are sorted so that two runs producing
 * the same record in a different property order still agree.
 */
export function canonicalBody(
  sequence: number,
  draft: JournalDraft,
  previousDigest: string,
): string {
  return JSON.stringify(
    {
      sequence,
      at: draft.at,
      kind: draft.kind,
      key: draft.key,
      payload: sortDeep(draft.payload),
      previousDigest,
    },
    null,
  );
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}

export function sealRecord(
  sequence: number,
  draft: JournalDraft,
  previousDigest: string,
): Result<JournalRecord> {
  if (!Number.isInteger(sequence) || sequence < 1) {
    return fail('journal_sequence_invalid', 'a journal sequence starts at one');
  }
  if (draft.kind.trim() === '') {
    return fail('journal_kind_missing', 'a journal record needs a kind');
  }
  if (draft.key.trim() === '') {
    return fail('journal_key_missing', 'a journal record needs a key');
  }
  const digest = digestOfParts([canonicalBody(sequence, draft, previousDigest)]);
  return ok({
    sequence,
    at: draft.at,
    kind: draft.kind,
    key: draft.key,
    payload: sortDeep(draft.payload) as JournalPayload,
    previousDigest,
    digest,
  });
}

export function encodeRecord(record: JournalRecord): string {
  return JSON.stringify(record);
}

export function decodeRecord(line: string): Result<JournalRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail('journal_line_unparseable', 'this line is not a journal record');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('journal_line_unparseable', 'this line is not a journal record');
  }
  const record = parsed as Partial<JournalRecord>;
  const missing = (['sequence', 'at', 'kind', 'key', 'previousDigest', 'digest'] as const).filter(
    (field) => record[field] === undefined,
  );
  if (missing.length > 0) {
    return fail('journal_record_incomplete', `the record has no ${missing.join(', ')}`);
  }
  if (record.payload === null || typeof record.payload !== 'object') {
    return fail('journal_record_incomplete', 'the record has no payload');
  }
  return ok(record as JournalRecord);
}

export function recomputeDigest(record: JournalRecord): string {
  return digestOfParts([
    canonicalBody(
      record.sequence,
      { at: record.at, kind: record.kind, key: record.key, payload: record.payload },
      record.previousDigest,
    ),
  ]);
}

export function isSealed(record: JournalRecord): boolean {
  return recomputeDigest(record) === record.digest;
}
