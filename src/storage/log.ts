/**
 * The append only log. It holds the sealed records in order and it can be
 * rebuilt from text, which is the only two things anything else needs from it.
 *
 * Verification walks the chain rather than checking each record on its own,
 * because a record that verifies against its own stored previous digest proves
 * nothing if that previous digest was also rewritten. The walk starts from the
 * genesis digest and each record has to match what the walk expects.
 */

import { fail, ok, type Result } from '../util/result.js';
import {
  GENESIS_DIGEST,
  decodeRecord,
  encodeRecord,
  recomputeDigest,
  sealRecord,
  type JournalDraft,
  type JournalRecord,
} from './journal.js';

export class JournalLog {
  private readonly records: JournalRecord[] = [];

  static empty(): JournalLog {
    return new JournalLog();
  }

  static fromRecords(records: readonly JournalRecord[]): Result<JournalLog> {
    const log = new JournalLog();
    for (const record of records) {
      log.records.push(record);
    }
    const verified = log.verify();
    return verified.ok ? ok(log) : verified;
  }

  static fromText(text: string): Result<JournalLog> {
    const records: JournalRecord[] = [];
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    for (let i = 0; i < lines.length; i += 1) {
      const decoded = decodeRecord(lines[i] as string);
      if (!decoded.ok) {
        return fail(
          decoded.problems[0]?.code ?? 'journal_line_unparseable',
          `line ${i + 1}: ${decoded.problems[0]?.message ?? 'cannot be read'}`,
        );
      }
      records.push(decoded.value);
    }
    return JournalLog.fromRecords(records);
  }

  get length(): number {
    return this.records.length;
  }

  get headDigest(): string {
    return this.records[this.records.length - 1]?.digest ?? GENESIS_DIGEST;
  }

  get nextSequence(): number {
    return this.records.length + 1;
  }

  append(draft: JournalDraft): Result<JournalRecord> {
    const sealed = sealRecord(this.nextSequence, draft, this.headDigest);
    if (!sealed.ok) {
      return sealed;
    }
    this.records.push(sealed.value);
    return ok(sealed.value);
  }

  appendAll(drafts: readonly JournalDraft[]): Result<JournalRecord[]> {
    const written: JournalRecord[] = [];
    const before = this.records.length;
    for (const draft of drafts) {
      const record = this.append(draft);
      if (!record.ok) {
        this.records.length = before;
        return record;
      }
      written.push(record.value);
    }
    return ok(written);
  }

  all(): readonly JournalRecord[] {
    return this.records;
  }

  at(sequence: number): JournalRecord | undefined {
    return this.records[sequence - 1];
  }

  since(sequence: number): JournalRecord[] {
    return this.records.filter((record) => record.sequence > sequence);
  }

  ofKind(kind: string): JournalRecord[] {
    return this.records.filter((record) => record.kind === kind);
  }

  forKey(key: string): JournalRecord[] {
    return this.records.filter((record) => record.key === key);
  }

  verify(): Result<number> {
    let expectedPrevious = GENESIS_DIGEST;
    for (let i = 0; i < this.records.length; i += 1) {
      const record = this.records[i] as JournalRecord;
      if (record.sequence !== i + 1) {
        return fail('journal_sequence_gap', `record ${i + 1} carries sequence ${record.sequence}`);
      }
      if (record.previousDigest !== expectedPrevious) {
        return fail(
          'journal_chain_broken',
          `record ${record.sequence} points at ${record.previousDigest}, the walk expected ${expectedPrevious}`,
        );
      }
      if (recomputeDigest(record) !== record.digest) {
        return fail('journal_record_tampered', `record ${record.sequence} does not seal`);
      }
      expectedPrevious = record.digest;
    }
    return ok(this.records.length);
  }

  /**
   * Drop everything after a sequence. Only a commit that failed to fold uses
   * this, and it uses it to put the log back where it was a moment ago rather
   * than to rewrite history.
   */
  truncateTo(sequence: number): Result<number> {
    if (!Number.isInteger(sequence) || sequence < 0) {
      return fail('journal_truncate_invalid', 'a truncation point is a whole number from zero');
    }
    if (sequence > this.records.length) {
      return fail('journal_truncate_ahead', 'cannot truncate past the end of the journal');
    }
    this.records.length = sequence;
    return ok(sequence);
  }

  toText(): string {
    return this.records.map(encodeRecord).join('\n');
  }
}
