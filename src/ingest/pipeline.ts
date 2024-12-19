/**
 * The ingest pipeline. Envelope, then rows, then dedupe, then quarantine, and
 * the result says what happened at every step rather than only what came out.
 *
 * The pipeline never throws and it never stops early on a row. It stops early
 * on exactly two things: an envelope it cannot read, and a row count that does
 * not match what the partner declared. Both mean the file itself is wrong, and
 * reading a wrong file half way is worse than not reading it.
 */

import type { Day } from '../util/clock.js';
import { fail, ok, type Problem, type Result } from '../util/result.js';
import type { Row } from './coerce.js';
import { dedupe, type DedupeCandidate, type DedupeResult } from './dedupe.js';
import { checkRowCount, readEnvelope, type FeedEnvelope } from './envelope.js';
import type { FeedRead } from './feed.js';
import { fileAll, type QuarantineEntry } from './quarantine.js';

export interface PipelineOptions<T> {
  readonly readRows: (envelope: FeedEnvelope, rows: readonly Row[]) => FeedRead<T>;
  readonly candidate: (item: T) => DedupeCandidate;
  readonly toleranceMillis: number;
  readonly filedOn: Day;
  /** Sequence numbers already processed for this source and kind. */
  readonly highestSequenceSeen?: number | undefined;
  readonly acceptReplays: boolean;
}

export interface PipelineOutcome<T> {
  readonly envelope: FeedEnvelope;
  readonly accepted: readonly T[];
  readonly duplicates: number;
  readonly quarantined: readonly QuarantineEntry[];
  readonly replay: boolean;
  readonly dedupeResult: DedupeResult<T>;
}

export function runPipeline<T>(
  rawEnvelope: unknown,
  rows: readonly Row[],
  options: PipelineOptions<T>,
): Result<PipelineOutcome<T>> {
  const envelope = readEnvelope(rawEnvelope);
  if (!envelope.ok) {
    return envelope;
  }
  const counted = checkRowCount(envelope.value, rows.length);
  if (!counted.ok) {
    return counted;
  }
  const replay =
    options.highestSequenceSeen !== undefined &&
    envelope.value.sequence <= options.highestSequenceSeen;
  if (replay && !options.acceptReplays) {
    return fail(
      'pipeline_replay_refused',
      `${envelope.value.source} #${envelope.value.sequence} has already been processed`,
    );
  }
  const read = options.readRows(envelope.value, rows);
  const deduped = dedupe(read.accepted, options.candidate, options.toleranceMillis);
  if (!deduped.ok) {
    return deduped;
  }
  return ok({
    envelope: envelope.value,
    accepted: deduped.value.kept,
    duplicates: deduped.value.duplicates.length,
    quarantined: fileAll(envelope.value, read.rejected, options.filedOn),
    replay,
    dedupeResult: deduped.value,
  });
}

export interface PipelineSummary {
  readonly source: string;
  readonly sequence: number;
  readonly rowsIn: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly quarantined: number;
  readonly replay: boolean;
}

export function summarize<T>(outcome: PipelineOutcome<T>): PipelineSummary {
  return {
    source: outcome.envelope.source,
    sequence: outcome.envelope.sequence,
    rowsIn: outcome.envelope.declaredRows,
    accepted: outcome.accepted.length,
    duplicates: outcome.duplicates,
    quarantined: outcome.quarantined.length,
    replay: outcome.replay,
  };
}

export function everyRowAccountedFor<T>(outcome: PipelineOutcome<T>): boolean {
  return (
    outcome.accepted.length + outcome.duplicates + outcome.quarantined.length ===
    outcome.envelope.declaredRows
  );
}

export function problemsOf(result: Result<unknown>): readonly Problem[] {
  return result.ok ? [] : result.problems;
}
