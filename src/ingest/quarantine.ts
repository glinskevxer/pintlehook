/**
 * Quarantine. A rejected row is not thrown away, it is filed with its problems
 * and its original text, and the desk works the file down.
 *
 * The one rule that earns its keep: a row that comes back fixed has to be
 * recognisable as the same row, so the quarantine key is the delivery and the
 * row number rather than anything in the content. A partner who fixes a typo
 * and reships should clear the entry rather than open a second one.
 */

import { compareDays, type Day } from '../util/clock.js';
import { digestOfParts } from '../util/digest.js';
import { byKey, byText, chain, groupBy, sorted } from '../util/ordering.js';
import { fail, ok, type Problem, type Result } from '../util/result.js';
import type { Row } from './coerce.js';
import type { FeedEnvelope, FeedKind } from './envelope.js';
import type { RejectedRow } from './feed.js';

export type QuarantineState = 'open' | 'resolved' | 'dismissed';

export interface QuarantineEntry {
  readonly key: string;
  readonly source: string;
  readonly kind: FeedKind;
  readonly sequence: number;
  readonly rowNumber: number;
  readonly problems: readonly Problem[];
  readonly row: Row;
  readonly filedOn: Day;
  readonly state: QuarantineState;
  readonly resolvedOn?: Day | undefined;
}

export function quarantineKey(envelope: FeedEnvelope, rowNumber: number): string {
  return digestOfParts([envelope.source, envelope.kind, envelope.sequence, rowNumber]);
}

export function fileRow(
  envelope: FeedEnvelope,
  rejected: RejectedRow,
  filedOn: Day,
): QuarantineEntry {
  return {
    key: quarantineKey(envelope, rejected.rowNumber),
    source: envelope.source,
    kind: envelope.kind,
    sequence: envelope.sequence,
    rowNumber: rejected.rowNumber,
    problems: rejected.problems,
    row: rejected.row,
    filedOn,
    state: 'open',
    resolvedOn: undefined,
  };
}

export function fileAll(
  envelope: FeedEnvelope,
  rejected: readonly RejectedRow[],
  filedOn: Day,
): QuarantineEntry[] {
  return rejected.map((row) => fileRow(envelope, row, filedOn));
}

export const entryOrder = chain(
  byKey((e: QuarantineEntry) => e.source, byText),
  byKey(
    (e: QuarantineEntry) => e.sequence,
    (a: number, b: number) => a - b,
  ),
  byKey(
    (e: QuarantineEntry) => e.rowNumber,
    (a: number, b: number) => a - b,
  ),
);

export function resolve(entry: QuarantineEntry, on: Day): Result<QuarantineEntry> {
  if (entry.state !== 'open') {
    return fail('quarantine_not_open', `this entry is already ${entry.state}`);
  }
  if (compareDays(on, entry.filedOn) < 0) {
    return fail('quarantine_resolved_before_filed', 'an entry cannot resolve before it was filed');
  }
  return ok({ ...entry, state: 'resolved', resolvedOn: on });
}

export function dismiss(entry: QuarantineEntry, on: Day): Result<QuarantineEntry> {
  if (entry.state !== 'open') {
    return fail('quarantine_not_open', `this entry is already ${entry.state}`);
  }
  return ok({ ...entry, state: 'dismissed', resolvedOn: on });
}

/** Fold a stream so a reshipped delivery replaces rather than doubles. */
export function fold(entries: readonly QuarantineEntry[]): QuarantineEntry[] {
  const latest = new Map<string, QuarantineEntry>();
  for (const entry of entries) {
    latest.set(entry.key, entry);
  }
  return sorted([...latest.values()], entryOrder);
}

export function openEntries(entries: readonly QuarantineEntry[]): QuarantineEntry[] {
  return sorted(
    fold(entries).filter((entry) => entry.state === 'open'),
    entryOrder,
  );
}

export function countBySource(entries: readonly QuarantineEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [source, group] of groupBy(entries, (entry) => entry.source)) {
    counts.set(source, group.length);
  }
  return counts;
}

export function countByProblemCode(entries: readonly QuarantineEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const problem of entry.problems) {
      counts.set(problem.code, (counts.get(problem.code) ?? 0) + 1);
    }
  }
  return counts;
}

export function describeEntry(entry: QuarantineEntry): string {
  const codes = entry.problems.map((problem) => problem.code).join(', ');
  return `${entry.source} #${entry.sequence} row ${entry.rowNumber}: ${codes}`;
}
