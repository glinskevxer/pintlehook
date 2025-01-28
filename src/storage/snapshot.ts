/**
 * Snapshots. Folding four years of journal on every start up is not something
 * anybody will put up with, so the state is written out periodically and the
 * fold resumes from there.
 *
 * A snapshot carries the sequence it was taken at and the head digest of the
 * journal at that moment. Loading one against a journal whose history has
 * changed underneath it is refused rather than reconciled, because a snapshot
 * that silently disagrees with the journal is worse than no snapshot.
 */

import { digestOfParts, digestOfSequence } from '../util/digest.js';
import { fail, ok, type Result } from '../util/result.js';
import { GENESIS_DIGEST } from './journal.js';
import type { JournalLog } from './log.js';

export const SNAPSHOT_FORMAT = 3;

export interface Snapshot {
  readonly format: number;
  readonly atSequence: number;
  readonly headDigest: string;
  readonly tables: Readonly<Record<string, readonly unknown[]>>;
  readonly digest: string;
}

export function snapshotBody(
  atSequence: number,
  headDigest: string,
  tables: Readonly<Record<string, readonly unknown[]>>,
): string {
  const names = Object.keys(tables).sort();
  const parts = names.map((name) => `${name}=${JSON.stringify(tables[name])}`);
  return `${SNAPSHOT_FORMAT}|${atSequence}|${headDigest}|${digestOfSequence(parts)}`;
}

export function takeSnapshot(
  log: JournalLog,
  tables: Readonly<Record<string, readonly unknown[]>>,
): Snapshot {
  const body = snapshotBody(log.length, log.headDigest, tables);
  return {
    format: SNAPSHOT_FORMAT,
    atSequence: log.length,
    headDigest: log.headDigest,
    tables,
    digest: digestOfParts([body]),
  };
}

export function isIntact(snapshot: Snapshot): boolean {
  return (
    digestOfParts([snapshotBody(snapshot.atSequence, snapshot.headDigest, snapshot.tables)]) ===
    snapshot.digest
  );
}

export function encodeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(snapshot);
}

export function decodeSnapshot(text: string): Result<Snapshot> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('snapshot_unparseable', 'this is not a snapshot');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('snapshot_unparseable', 'this is not a snapshot');
  }
  const snapshot = parsed as Partial<Snapshot>;
  if (
    typeof snapshot.format !== 'number' ||
    typeof snapshot.atSequence !== 'number' ||
    typeof snapshot.headDigest !== 'string' ||
    typeof snapshot.digest !== 'string' ||
    snapshot.tables === undefined
  ) {
    return fail('snapshot_incomplete', 'the snapshot is missing a field');
  }
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    return fail(
      'snapshot_format_unsupported',
      `this snapshot is format ${snapshot.format} and we read ${SNAPSHOT_FORMAT}`,
    );
  }
  const whole = snapshot as Snapshot;
  if (!isIntact(whole)) {
    return fail('snapshot_tampered', 'the snapshot does not match its own digest');
  }
  return ok(whole);
}

/** A snapshot only loads against the journal it was taken from. */
export function checkAgainstLog(snapshot: Snapshot, log: JournalLog): Result<number> {
  if (snapshot.atSequence > log.length) {
    return fail(
      'snapshot_ahead_of_journal',
      `the snapshot is at ${snapshot.atSequence} and the journal holds ${log.length}`,
    );
  }
  const expected =
    snapshot.atSequence === 0 ? GENESIS_DIGEST : (log.at(snapshot.atSequence)?.digest ?? '');
  if (expected !== snapshot.headDigest) {
    return fail(
      'snapshot_journal_diverged',
      'the journal has changed since this snapshot was taken',
    );
  }
  return ok(log.length - snapshot.atSequence);
}

export function rowsOf<T>(snapshot: Snapshot, table: string): readonly T[] {
  return (snapshot.tables[table] ?? []) as readonly T[];
}

export function tableNames(snapshot: Snapshot): string[] {
  return Object.keys(snapshot.tables).sort();
}
