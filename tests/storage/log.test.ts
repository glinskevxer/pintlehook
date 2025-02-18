import { describe, expect, it } from 'vitest';
import {
  GENESIS_DIGEST,
  encodeRecord,
  sealRecord,
  type JournalDraft,
} from '../../src/storage/journal.js';
import { JournalLog } from '../../src/storage/log.js';
import { isErr, unwrap } from '../../src/util/result.js';

function draft(key: string, kind = 'touch_recorded'): JournalDraft {
  return {
    at: Date.UTC(2025, 4, 1, 12, 0, 0),
    kind,
    key,
    payload: { note: key },
  };
}

function filled(): JournalLog {
  const log = JournalLog.empty();
  unwrap(log.append(draft('a')));
  unwrap(log.append(draft('b', 'load_delivered')));
  unwrap(log.append(draft('c')));
  return log;
}

describe('an empty log', () => {
  it('starts at the genesis digest', () => {
    const log = JournalLog.empty();
    expect(log.length).toBe(0);
    expect(log.headDigest).toBe(GENESIS_DIGEST);
    expect(log.nextSequence).toBe(1);
  });

  it('verifies', () => {
    expect(unwrap(JournalLog.empty().verify())).toBe(0);
  });

  it('writes an empty text', () => {
    expect(JournalLog.empty().toText()).toBe('');
  });
});

describe('append', () => {
  it('numbers from one and chains', () => {
    const log = JournalLog.empty();
    const first = unwrap(log.append(draft('a')));
    const second = unwrap(log.append(draft('b')));
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousDigest).toBe(first.digest);
    expect(log.headDigest).toBe(second.digest);
  });

  it('refuses a draft with no key and leaves the log alone', () => {
    const log = JournalLog.empty();
    expect(isErr(log.append(draft('')))).toBe(true);
    expect(log.length).toBe(0);
  });
});

describe('appendAll', () => {
  it('writes every draft', () => {
    const log = JournalLog.empty();
    expect(unwrap(log.appendAll([draft('a'), draft('b')]))).toHaveLength(2);
    expect(log.length).toBe(2);
  });

  it('writes nothing at all when one draft is bad', () => {
    const log = JournalLog.empty();
    unwrap(log.append(draft('first')));
    expect(isErr(log.appendAll([draft('a'), draft(''), draft('c')]))).toBe(true);
    expect(log.length).toBe(1);
    expect(unwrap(log.verify())).toBe(1);
  });
});

describe('reading', () => {
  const log = filled();

  it('reads by sequence', () => {
    expect(log.at(2)!.key).toBe('b');
    expect(log.at(9)).toBeUndefined();
    expect(log.at(0)).toBeUndefined();
  });

  it('reads everything after a sequence', () => {
    expect(log.since(1).map((r) => r.key)).toEqual(['b', 'c']);
    expect(log.since(3)).toEqual([]);
  });

  it('filters by kind', () => {
    expect(log.ofKind('load_delivered')).toHaveLength(1);
    expect(log.ofKind('nothing')).toEqual([]);
  });

  it('filters by key', () => {
    expect(log.forKey('c')).toHaveLength(1);
  });
});

describe('verify', () => {
  it('accepts a log it wrote itself', () => {
    expect(unwrap(filled().verify())).toBe(3);
  });

  it('catches a record whose payload was edited', () => {
    const records = [...filled().all()];
    const second = records[1]!;
    records[1] = { ...second, payload: { note: 'edited' } };
    const r = JournalLog.fromRecords(records);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('journal_record_tampered');
    }
  });

  it('catches a record dropped out of the middle', () => {
    const records = [...filled().all()];
    const r = JournalLog.fromRecords([records[0]!, records[2]!]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('journal_sequence_gap');
    }
  });

  it('catches a chain that points at the wrong record', () => {
    const records = [...filled().all()];
    records[1] = { ...records[1]!, previousDigest: 'ffffffff' };
    const r = JournalLog.fromRecords(records);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('journal_chain_broken');
    }
  });

  it('catches a record resealed against a rewritten previous digest', () => {
    const original = filled().all();
    const edited = unwrap(
      sealRecord(
        2,
        {
          at: original[1]!.at,
          kind: original[1]!.kind,
          key: 'edited',
          payload: { note: 'edited' },
        },
        original[0]!.digest,
      ),
    );
    const r = JournalLog.fromRecords([original[0]!, edited, original[2]!]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('journal_chain_broken');
    }
  });
});

describe('text round trip', () => {
  it('rebuilds a log from its own text', () => {
    const log = filled();
    const again = unwrap(JournalLog.fromText(log.toText()));
    expect(again.length).toBe(3);
    expect(again.headDigest).toBe(log.headDigest);
  });

  it('ignores blank lines', () => {
    const text = `${filled().toText()}\n\n`;
    expect(unwrap(JournalLog.fromText(text)).length).toBe(3);
  });

  it('reads an empty text as an empty log', () => {
    expect(unwrap(JournalLog.fromText('')).length).toBe(0);
  });

  it('names the line it could not read', () => {
    const text = `${encodeRecord(filled().all()[0]!)}\nnot a record`;
    const r = JournalLog.fromText(text);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('line 2');
    }
  });

  it('refuses text whose chain does not hold', () => {
    const records = [...filled().all()];
    records[1] = { ...records[1]!, previousDigest: 'ffffffff' };
    expect(isErr(JournalLog.fromText(records.map(encodeRecord).join('\n')))).toBe(true);
  });

  it('keeps appending after a rebuild', () => {
    const again = unwrap(JournalLog.fromText(filled().toText()));
    const fourth = unwrap(again.append(draft('d')));
    expect(fourth.sequence).toBe(4);
    expect(unwrap(again.verify())).toBe(4);
  });
});

describe('truncateTo', () => {
  it('drops everything after a sequence', () => {
    const log = filled();
    expect(unwrap(log.truncateTo(1))).toBe(1);
    expect(log.length).toBe(1);
    expect(unwrap(log.verify())).toBe(1);
  });

  it('leaves the head digest where the kept record put it', () => {
    const log = filled();
    const first = log.at(1)!;
    unwrap(log.truncateTo(1));
    expect(log.headDigest).toBe(first.digest);
    expect(log.nextSequence).toBe(2);
  });

  it('empties the log at zero', () => {
    const log = filled();
    unwrap(log.truncateTo(0));
    expect(log.length).toBe(0);
    expect(log.headDigest).toBe(GENESIS_DIGEST);
  });

  it('refuses a point past the end', () => {
    expect(isErr(filled().truncateTo(9))).toBe(true);
  });

  it('refuses a negative point', () => {
    expect(isErr(filled().truncateTo(-1))).toBe(true);
  });

  it('lets appending carry on from there', () => {
    const log = filled();
    unwrap(log.truncateTo(2));
    expect(unwrap(log.append(draft('new'))).sequence).toBe(3);
    expect(unwrap(log.verify())).toBe(3);
  });
});
