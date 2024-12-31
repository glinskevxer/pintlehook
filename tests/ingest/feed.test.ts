import { describe, expect, it } from 'vitest';
import { readEnvelope } from '../../src/ingest/envelope.js';
import {
  acceptanceRate,
  describeRead,
  isClean,
  readRows,
  rejectedCodes,
  rowReference,
  type FeedRead,
} from '../../src/ingest/feed.js';
import { fail, ok, problem, unwrap } from '../../src/util/result.js';

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

const read: FeedRead<string> = {
  envelope,
  accepted: ['one', 'two'],
  rejected: [{ rowNumber: 3, problems: [problem('field_missing', 'no code')], row: { a: '' } }],
};

describe('rowReference', () => {
  it('names the file and the row', () => {
    expect(rowReference(envelope, 41)).toBe('fuel-desk/touch/118:41');
  });
});

describe('acceptanceRate', () => {
  it('is the share accepted', () => {
    expect(acceptanceRate(read)).toBeCloseTo(2 / 3);
  });

  it('is one for an empty file', () => {
    expect(acceptanceRate({ envelope, accepted: [], rejected: [] })).toBe(1);
  });

  it('is zero when nothing came through', () => {
    expect(acceptanceRate({ ...read, accepted: [] })).toBe(0);
  });
});

describe('isClean', () => {
  it('is false when anything was rejected', () => {
    expect(isClean(read)).toBe(false);
    expect(isClean({ envelope, accepted: ['one'], rejected: [] })).toBe(true);
  });
});

describe('rejectedCodes', () => {
  it('lists the distinct codes in order', () => {
    const many: FeedRead<string> = {
      ...read,
      rejected: [
        { rowNumber: 3, problems: [problem('zzz', 'x'), problem('aaa', 'y')], row: {} },
        { rowNumber: 4, problems: [problem('aaa', 'y')], row: {} },
      ],
    };
    expect(rejectedCodes(many)).toEqual(['aaa', 'zzz']);
  });

  it('is empty for a clean read', () => {
    expect(rejectedCodes({ envelope, accepted: [], rejected: [] })).toEqual([]);
  });
});

describe('describeRead', () => {
  it('reads the way the ingest log prints it', () => {
    expect(describeRead(read)).toBe('2 accepted, 1 rejected from fuel-desk');
  });
});

describe('readRows', () => {
  it('numbers rows from one and splits them', () => {
    const read = readRows(envelope, [{ a: '1' }, { a: '' }, { a: '3' }], (_envelope, row, at) =>
      row['a'] === '' ? fail('blank', 'nothing there') : ok({ at, value: row['a'] as string }),
    );
    expect(read.accepted.map((row) => row.at)).toEqual([1, 3]);
    expect(read.rejected[0]!.rowNumber).toBe(2);
  });

  it('keeps the original row on a rejection', () => {
    const read = readRows(envelope, [{ a: 'bad' }], () => fail('blank', 'nothing there'));
    expect(read.rejected[0]!.row['a']).toBe('bad');
  });

  it('reads an empty file', () => {
    const read = readRows(envelope, [], () => fail('blank', 'nothing there'));
    expect(read.accepted).toEqual([]);
    expect(read.rejected).toEqual([]);
  });

  it('carries the envelope through', () => {
    expect(readRows(envelope, [], () => fail('x', 'y')).envelope.source).toBe('fuel-desk');
  });
});
