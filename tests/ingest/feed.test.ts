import { describe, expect, it } from 'vitest';
import { readEnvelope } from '../../src/ingest/envelope.js';
import {
  acceptanceRate,
  describeRead,
  isClean,
  rejectedCodes,
  rowReference,
  type FeedRead,
} from '../../src/ingest/feed.js';
import { problem, unwrap } from '../../src/util/result.js';

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
