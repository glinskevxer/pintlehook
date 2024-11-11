import { describe, expect, it } from 'vitest';
import {
  FEED_KINDS,
  checkRowCount,
  describeEnvelope,
  envelopeKey,
  isFeedKind,
  isReplay,
  readEnvelope,
} from '../../src/ingest/envelope.js';
import { isErr, unwrap } from '../../src/util/result.js';

const raw = {
  source: 'fuel-desk',
  kind: 'touch',
  cutAt: '2025-04-01T06:00:00Z',
  declaredRows: 412,
  zone: 'America/Chicago',
  sequence: 118,
};

describe('feed kinds', () => {
  it('names four', () => {
    expect(FEED_KINDS).toHaveLength(4);
    expect(isFeedKind('claim')).toBe(true);
    expect(isFeedKind('invoice')).toBe(false);
  });
});

describe('readEnvelope', () => {
  it('reads a good envelope', () => {
    const envelope = unwrap(readEnvelope(raw));
    expect(envelope.source).toBe('fuel-desk');
    expect(envelope.kind).toBe('touch');
    expect(envelope.cutAt).toBe(Date.UTC(2025, 3, 1, 6, 0, 0));
  });

  it('rejects a missing field and says which', () => {
    const { source: _source, ...rest } = raw;
    const r = readEnvelope(rest);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.path).toBe('source');
    }
  });

  it('rejects an unknown feed kind', () => {
    expect(isErr(readEnvelope({ ...raw, kind: 'invoice' }))).toBe(true);
  });

  it('rejects a negative row count', () => {
    expect(isErr(readEnvelope({ ...raw, declaredRows: -1 }))).toBe(true);
  });

  it('rejects a fractional sequence', () => {
    expect(isErr(readEnvelope({ ...raw, sequence: 1.5 }))).toBe(true);
  });

  it('rejects an unreadable instant', () => {
    expect(isErr(readEnvelope({ ...raw, cutAt: 'yesterday' }))).toBe(true);
  });

  it('rejects a zone it has no rule table for', () => {
    const r = readEnvelope({ ...raw, zone: 'Europe/Riga' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('envelope_zone_unknown');
      expect(r.problems[0]!.path).toBe('zone');
    }
  });

  it('rejects something that is not an object at all', () => {
    expect(isErr(readEnvelope('fuel-desk'))).toBe(true);
    expect(isErr(readEnvelope(null))).toBe(true);
  });

  it('accepts an empty delivery', () => {
    expect(unwrap(readEnvelope({ ...raw, declaredRows: 0 })).declaredRows).toBe(0);
  });
});

describe('envelopeKey', () => {
  it('is the source, kind and sequence', () => {
    const one = envelopeKey(unwrap(readEnvelope(raw)));
    const same = envelopeKey(unwrap(readEnvelope({ ...raw, declaredRows: 9 })));
    expect(same).toBe(one);
  });

  it('separates two sequences', () => {
    const one = envelopeKey(unwrap(readEnvelope(raw)));
    const two = envelopeKey(unwrap(readEnvelope({ ...raw, sequence: 119 })));
    expect(two).not.toBe(one);
  });

  it('separates two sources', () => {
    const one = envelopeKey(unwrap(readEnvelope(raw)));
    const two = envelopeKey(unwrap(readEnvelope({ ...raw, source: 'recruiting' })));
    expect(two).not.toBe(one);
  });
});

describe('checkRowCount', () => {
  it('accepts the declared count', () => {
    expect(unwrap(checkRowCount(unwrap(readEnvelope(raw)), 412))).toBe(412);
  });

  it('rejects a truncated file and names both numbers', () => {
    const r = checkRowCount(unwrap(readEnvelope(raw)), 400);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('412');
      expect(r.problems[0]!.message).toContain('400');
    }
  });
});

describe('isReplay', () => {
  it('is not a replay when nothing has been seen', () => {
    expect(isReplay(unwrap(readEnvelope(raw)), undefined)).toBe(false);
  });

  it('is a replay at or below the highest seen', () => {
    const envelope = unwrap(readEnvelope(raw));
    expect(isReplay(envelope, 118)).toBe(true);
    expect(isReplay(envelope, 200)).toBe(true);
    expect(isReplay(envelope, 117)).toBe(false);
  });
});

describe('describeEnvelope', () => {
  it('reads the way the ingest log prints it', () => {
    expect(describeEnvelope(unwrap(readEnvelope(raw)))).toBe('fuel-desk touch #118 with 412 rows');
  });
});
