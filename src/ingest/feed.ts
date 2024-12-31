/**
 * What every feed adapter returns. A batch is never all or nothing: a bad row
 * is set aside with its problems and its original text, and the rest of the
 * file goes through. A partner who ships four thousand rows with two bad ones
 * should not have to ship the file again.
 */

import type { Problem, Result } from '../util/result.js';
import type { FeedEnvelope } from './envelope.js';
import type { Row } from './coerce.js';

export interface RejectedRow {
  readonly rowNumber: number;
  readonly problems: readonly Problem[];
  readonly row: Row;
}

export interface FeedRead<T> {
  readonly envelope: FeedEnvelope;
  readonly accepted: readonly T[];
  readonly rejected: readonly RejectedRow[];
}

/**
 * Every adapter walked the rows the same way, numbering from one and splitting
 * the results into two lists. Four copies of that loop meant four places to get
 * the row numbering wrong, so it lives here now and an adapter only says how to
 * read one row.
 */
export function readRows<T>(
  envelope: FeedEnvelope,
  rows: readonly Row[],
  readOne: (envelope: FeedEnvelope, row: Row, rowNumber: number) => Result<T>,
): FeedRead<T> {
  const accepted: T[] = [];
  const rejected: RejectedRow[] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const read = readOne(envelope, row, rowNumber);
    if (read.ok) {
      accepted.push(read.value);
    } else {
      rejected.push({ rowNumber, problems: read.problems, row });
    }
  });
  return { envelope, accepted, rejected };
}

export function rowReference(envelope: FeedEnvelope, rowNumber: number): string {
  return `${envelope.source}/${envelope.kind}/${envelope.sequence}:${rowNumber}`;
}

export function acceptanceRate(read: FeedRead<unknown>): number {
  const total = read.accepted.length + read.rejected.length;
  return total === 0 ? 1 : read.accepted.length / total;
}

export function isClean(read: FeedRead<unknown>): boolean {
  return read.rejected.length === 0;
}

export function rejectedCodes(read: FeedRead<unknown>): string[] {
  const codes = new Set<string>();
  for (const rejected of read.rejected) {
    for (const problem of rejected.problems) {
      codes.add(problem.code);
    }
  }
  return [...codes].sort();
}

export function describeRead(read: FeedRead<unknown>): string {
  return `${read.accepted.length} accepted, ${read.rejected.length} rejected from ${read.envelope.source}`;
}
