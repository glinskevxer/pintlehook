/**
 * Compaction. A journal that has been running for four years is slow to fold
 * and expensive to ship, and most of it is settled: batches paid, referrals
 * closed, program years over.
 *
 * What compaction does not do is throw the old records away. It writes a
 * checkpoint that a reader can resume from and reports what could be archived,
 * and the archiving is somebody's decision with a retention policy in front of
 * them. A storage layer that silently discards settled history is a storage
 * layer that loses the one thing an auditor asks for.
 */

import { compareDays, formatDay, type Day } from '../util/clock.js';
import { fail, ok, type Result } from '../util/result.js';
import type { JournalRecord } from './journal.js';
import { JournalLog } from './log.js';
import { readDayText } from './rows.js';
import { takeSnapshot, type Snapshot } from './snapshot.js';
import type { Store } from './store.js';

/** Kinds that describe something finished, so nothing later depends on them. */
export const SETTLED_KINDS = ['batch_paid', 'eligibility_flag_cleared'] as const;

export interface CompactionPlan {
  readonly upToSequence: number;
  readonly snapshot: Snapshot;
  readonly archivable: number;
  readonly retained: number;
  readonly settledBatches: readonly string[];
}

function paidBatches(store: Store): string[] {
  return store.batches
    .where((row) => row.state === 'paid')
    .map((row) => row.id)
    .sort();
}

/**
 * Everything the store would still need if the journal were replayed from a
 * checkpoint. A record is archivable when it is at or below the checkpoint.
 */
export function planCompaction(store: Store, upToSequence: number): Result<CompactionPlan> {
  if (!Number.isInteger(upToSequence) || upToSequence < 0) {
    return fail('compaction_point_invalid', 'a checkpoint is a whole number from zero');
  }
  if (upToSequence > store.sequence) {
    return fail(
      'compaction_point_ahead',
      `the journal holds ${store.sequence} records and the checkpoint is ${upToSequence}`,
    );
  }
  return ok({
    upToSequence,
    snapshot: takeSnapshot(store.journal, snapshotTables(store)),
    archivable: upToSequence,
    retained: store.sequence - upToSequence,
    settledBatches: paidBatches(store),
  });
}

function snapshotTables(store: Store): Record<string, readonly unknown[]> {
  return {
    carriers: store.carriers.all(),
    advocates: store.advocates.all(),
    touches: store.touches.all(),
    referrals: store.referrals.all(),
    loads: store.loads.all(),
    claims: store.claims.all(),
    accruals: store.accruals.all(),
    batches: store.batches.all(),
    flags: store.flags.all(),
  };
}

/**
 * The latest sequence that is safe to compact to: everything before the oldest
 * batch that has not been paid, because a batch still moving can be answered by
 * a posting that has to stay foldable.
 */
export function safeCheckpoint(store: Store): number {
  const unpaid = store.batches.where((row) => row.state !== 'paid' && row.state !== 'void');
  if (unpaid.length === 0) {
    return store.sequence;
  }
  const keys = new Set(unpaid.map((row) => row.id));
  const records = store.journal.all();
  for (let at = 0; at < records.length; at += 1) {
    if (keys.has((records[at] as JournalRecord).key)) {
      return at;
    }
  }
  return store.sequence;
}

export function archivableRecords(store: Store, upToSequence: number): JournalRecord[] {
  return store.journal.all().filter((record) => record.sequence <= upToSequence);
}

export function retainedLog(store: Store, upToSequence: number): Result<JournalLog> {
  const kept = store.journal.all().filter((record) => record.sequence > upToSequence);
  return kept.length === store.sequence
    ? ok(store.journal)
    : JournalLog.fromRecords(store.journal.all()).ok
      ? ok(store.journal)
      : fail('compaction_retained_broken', 'the retained records do not verify');
}

export function oldestOpenDay(store: Store): Result<Day | undefined> {
  let oldest: Day | undefined;
  for (const row of store.batches.where((batch) => batch.state !== 'paid')) {
    const cutOn = readDayText(row.cutOn, 'cutOn');
    if (!cutOn.ok) {
      return cutOn;
    }
    if (
      cutOn.value !== undefined &&
      (oldest === undefined || compareDays(cutOn.value, oldest) < 0)
    ) {
      oldest = cutOn.value;
    }
  }
  return ok(oldest);
}

export function describePlan(plan: CompactionPlan): string {
  return [
    `checkpoint at ${plan.upToSequence}`,
    `${plan.archivable} archivable`,
    `${plan.retained} retained`,
    `${plan.settledBatches.length} paid batches`,
  ].join(', ');
}

export function describeOldestOpen(day: Day | undefined): string {
  return day === undefined
    ? 'every batch is paid'
    : `the oldest open batch was cut ${formatDay(day)}`;
}
