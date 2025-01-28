import { describe, expect, it } from 'vitest';
import type { JournalDraft } from '../../src/storage/journal.js';
import { JournalLog } from '../../src/storage/log.js';
import {
  SNAPSHOT_FORMAT,
  checkAgainstLog,
  decodeSnapshot,
  encodeSnapshot,
  isIntact,
  rowsOf,
  snapshotBody,
  tableNames,
  takeSnapshot,
} from '../../src/storage/snapshot.js';
import { isErr, unwrap } from '../../src/util/result.js';

function draft(key: string): JournalDraft {
  return { at: Date.UTC(2025, 4, 1), kind: 'thing_happened', key, payload: { key } };
}

function logOf(count: number): JournalLog {
  const log = JournalLog.empty();
  for (let i = 1; i <= count; i += 1) {
    unwrap(log.append(draft(`k${i}`)));
  }
  return log;
}

const tables = {
  advocates: [{ id: 'adv_1' }, { id: 'adv_2' }],
  carriers: [{ id: 'cxr_1' }],
};

describe('snapshotBody', () => {
  it('does not depend on the order the tables were written in', () => {
    const one = snapshotBody(3, 'aaaa', { a: [1], b: [2] });
    const other = snapshotBody(3, 'aaaa', { b: [2], a: [1] });
    expect(other).toBe(one);
  });

  it('changes when a row changes', () => {
    expect(snapshotBody(3, 'aaaa', { a: [1] })).not.toBe(snapshotBody(3, 'aaaa', { a: [2] }));
  });
});

describe('takeSnapshot', () => {
  it('records where the journal was', () => {
    const log = logOf(3);
    const snapshot = takeSnapshot(log, tables);
    expect(snapshot.atSequence).toBe(3);
    expect(snapshot.headDigest).toBe(log.headDigest);
    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
  });

  it('is intact when it is taken', () => {
    expect(isIntact(takeSnapshot(logOf(3), tables))).toBe(true);
  });

  it('can be taken over an empty journal', () => {
    const snapshot = takeSnapshot(JournalLog.empty(), {});
    expect(snapshot.atSequence).toBe(0);
    expect(isIntact(snapshot)).toBe(true);
  });
});

describe('isIntact', () => {
  it('sees a row edited after the snapshot was taken', () => {
    const snapshot = takeSnapshot(logOf(3), tables);
    expect(isIntact({ ...snapshot, tables: { ...tables, carriers: [{ id: 'cxr_9' }] } })).toBe(
      false,
    );
  });

  it('sees the sequence edited after the fact', () => {
    const snapshot = takeSnapshot(logOf(3), tables);
    expect(isIntact({ ...snapshot, atSequence: 2 })).toBe(false);
  });
});

describe('encode and decode', () => {
  it('round trips', () => {
    const snapshot = takeSnapshot(logOf(3), tables);
    expect(unwrap(decodeSnapshot(encodeSnapshot(snapshot)))).toEqual(snapshot);
  });

  it('refuses text that is not json', () => {
    expect(isErr(decodeSnapshot('not a snapshot'))).toBe(true);
  });

  it('refuses json that is not an object', () => {
    expect(isErr(decodeSnapshot('[1,2]'))).toBe(true);
  });

  it('refuses a snapshot missing a field', () => {
    const snapshot = takeSnapshot(logOf(3), tables);
    const { digest: _digest, ...rest } = snapshot;
    const r = decodeSnapshot(JSON.stringify(rest));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('snapshot_incomplete');
    }
  });

  it('refuses a snapshot from another format', () => {
    const snapshot = takeSnapshot(logOf(3), tables);
    const r = decodeSnapshot(JSON.stringify({ ...snapshot, format: 1 }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('snapshot_format_unsupported');
    }
  });

  it('refuses a snapshot whose rows were edited', () => {
    const snapshot = takeSnapshot(logOf(3), tables);
    const r = decodeSnapshot(JSON.stringify({ ...snapshot, tables: { ...tables, carriers: [] } }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('snapshot_tampered');
    }
  });
});

describe('checkAgainstLog', () => {
  it('accepts a snapshot taken from the same journal', () => {
    const log = logOf(3);
    const snapshot = takeSnapshot(log, tables);
    expect(unwrap(checkAgainstLog(snapshot, log))).toBe(0);
  });

  it('says how far behind the snapshot is', () => {
    const log = logOf(3);
    const snapshot = takeSnapshot(log, tables);
    unwrap(log.append(draft('k4')));
    unwrap(log.append(draft('k5')));
    expect(unwrap(checkAgainstLog(snapshot, log))).toBe(2);
  });

  it('accepts an empty snapshot against any journal', () => {
    const snapshot = takeSnapshot(JournalLog.empty(), {});
    expect(unwrap(checkAgainstLog(snapshot, logOf(3)))).toBe(3);
  });

  it('refuses a snapshot ahead of the journal', () => {
    const snapshot = takeSnapshot(logOf(5), tables);
    const r = checkAgainstLog(snapshot, logOf(3));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('snapshot_ahead_of_journal');
    }
  });

  it('refuses a snapshot from a journal that has since been rewritten', () => {
    const snapshot = takeSnapshot(logOf(3), tables);
    const other = JournalLog.empty();
    unwrap(other.append(draft('different')));
    unwrap(other.append(draft('k2')));
    unwrap(other.append(draft('k3')));
    const r = checkAgainstLog(snapshot, other);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('snapshot_journal_diverged');
    }
  });
});

describe('reading a snapshot', () => {
  it('reads a table back', () => {
    const snapshot = takeSnapshot(logOf(1), tables);
    expect(rowsOf<{ id: string }>(snapshot, 'advocates')).toHaveLength(2);
  });

  it('reads nothing for a table that was not written', () => {
    expect(rowsOf(takeSnapshot(logOf(1), tables), 'nothing')).toEqual([]);
  });

  it('lists its tables in order', () => {
    expect(tableNames(takeSnapshot(logOf(1), tables))).toEqual(['advocates', 'carriers']);
  });
});
