import { describe, expect, it } from 'vitest';
import { readEnvelope } from '../../src/ingest/envelope.js';
import type { RejectedRow } from '../../src/ingest/feed.js';
import {
  countByProblemCode,
  countBySource,
  describeEntry,
  dismiss,
  fileAll,
  fileRow,
  fold,
  openEntries,
  quarantineKey,
  resolve,
} from '../../src/ingest/quarantine.js';
import { day } from '../../src/util/clock.js';
import { isErr, problem, unwrap } from '../../src/util/result.js';

const envelope = unwrap(
  readEnvelope({
    source: 'fuel-desk',
    kind: 'touch',
    cutAt: '2025-04-01T06:00:00Z',
    declaredRows: 3,
    zone: 'America/Chicago',
    sequence: 118,
  }),
);

const filedOn = day(2025, 4, 1);

function rejected(rowNumber: number, code = 'field_missing'): RejectedRow {
  return {
    rowNumber,
    problems: [problem(code, 'no code', 'referral_code')],
    row: { referral_code: '', channel: 'card' },
  };
}

describe('quarantineKey', () => {
  it('is the delivery and the row number, not the content', () => {
    expect(quarantineKey(envelope, 3)).toBe(quarantineKey(envelope, 3));
    expect(quarantineKey(envelope, 4)).not.toBe(quarantineKey(envelope, 3));
  });
});

describe('fileRow', () => {
  it('files an entry open with everything the desk needs', () => {
    const entry = fileRow(envelope, rejected(3), filedOn);
    expect(entry.state).toBe('open');
    expect(entry.source).toBe('fuel-desk');
    expect(entry.sequence).toBe(118);
    expect(entry.rowNumber).toBe(3);
    expect(entry.row['channel']).toBe('card');
    expect(entry.problems).toHaveLength(1);
  });
});

describe('fileAll', () => {
  it('files one entry per rejected row', () => {
    expect(fileAll(envelope, [rejected(1), rejected(2)], filedOn)).toHaveLength(2);
  });
});

describe('resolve and dismiss', () => {
  it('resolves an open entry', () => {
    const entry = unwrap(resolve(fileRow(envelope, rejected(3), filedOn), day(2025, 4, 5)));
    expect(entry.state).toBe('resolved');
    expect(entry.resolvedOn).toEqual(day(2025, 4, 5));
  });

  it('refuses to resolve twice', () => {
    const once = unwrap(resolve(fileRow(envelope, rejected(3), filedOn), day(2025, 4, 5)));
    const r = resolve(once, day(2025, 4, 6));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('quarantine_not_open');
    }
  });

  it('refuses a resolution dated before the filing', () => {
    const r = resolve(fileRow(envelope, rejected(3), filedOn), day(2025, 3, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('quarantine_resolved_before_filed');
    }
  });

  it('dismisses an open entry', () => {
    const entry = unwrap(dismiss(fileRow(envelope, rejected(3), filedOn), day(2025, 4, 5)));
    expect(entry.state).toBe('dismissed');
  });

  it('refuses to dismiss a resolved entry', () => {
    const once = unwrap(resolve(fileRow(envelope, rejected(3), filedOn), day(2025, 4, 5)));
    expect(isErr(dismiss(once, day(2025, 4, 6)))).toBe(true);
  });
});

describe('fold', () => {
  it('lets a reshipped delivery replace rather than double', () => {
    const first = fileRow(envelope, rejected(3), filedOn);
    const again = fileRow(envelope, rejected(3, 'field_not_boolean'), day(2025, 4, 8));
    const folded = fold([first, again]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.problems[0]!.code).toBe('field_not_boolean');
  });

  it('keeps two rows of the same delivery apart', () => {
    expect(fold(fileAll(envelope, [rejected(1), rejected(2)], filedOn))).toHaveLength(2);
  });

  it('sorts by source then sequence then row', () => {
    const other = unwrap(
      readEnvelope({
        ...envelope,
        cutAt: '2025-04-01T06:00:00Z',
        source: 'aaa',
        kind: 'touch',
        declaredRows: 1,
        zone: 'UTC',
        sequence: 1,
      }),
    );
    const folded = fold([
      ...fileAll(envelope, [rejected(2), rejected(1)], filedOn),
      ...fileAll(other, [rejected(1)], filedOn),
    ]);
    expect(folded.map((entry) => entry.source)).toEqual(['aaa', 'fuel-desk', 'fuel-desk']);
    expect(folded[1]!.rowNumber).toBe(1);
  });
});

describe('openEntries', () => {
  it('drops the resolved ones', () => {
    const entries = fileAll(envelope, [rejected(1), rejected(2)], filedOn);
    const resolved = unwrap(resolve(entries[0]!, day(2025, 4, 5)));
    expect(openEntries([...entries, resolved])).toHaveLength(1);
  });

  it('sees a reshipped row as still open when it failed again', () => {
    const first = fileRow(envelope, rejected(3), filedOn);
    const resolved = unwrap(resolve(first, day(2025, 4, 5)));
    const again = fileRow(envelope, rejected(3), day(2025, 4, 8));
    expect(openEntries([first, resolved, again])).toHaveLength(1);
  });
});

describe('counting', () => {
  it('counts by source', () => {
    const counts = countBySource(fileAll(envelope, [rejected(1), rejected(2)], filedOn));
    expect(counts.get('fuel-desk')).toBe(2);
  });

  it('counts by problem code', () => {
    const counts = countByProblemCode(
      fileAll(envelope, [rejected(1), rejected(2, 'field_not_day')], filedOn),
    );
    expect(counts.get('field_missing')).toBe(1);
    expect(counts.get('field_not_day')).toBe(1);
  });
});

describe('describeEntry', () => {
  it('reads the way the working list prints it', () => {
    expect(describeEntry(fileRow(envelope, rejected(3), filedOn))).toBe(
      'fuel-desk #118 row 3: field_missing',
    );
  });
});
