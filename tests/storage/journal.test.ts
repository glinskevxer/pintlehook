import { describe, expect, it } from 'vitest';
import {
  GENESIS_DIGEST,
  canonicalBody,
  decodeRecord,
  encodeRecord,
  isSealed,
  recomputeDigest,
  sealRecord,
  type JournalDraft,
} from '../../src/storage/journal.js';
import { isErr, unwrap } from '../../src/util/result.js';

const draft: JournalDraft = {
  at: Date.UTC(2025, 4, 1, 12, 0, 0),
  kind: 'touch_recorded',
  key: 'tch_00000001',
  payload: { advocate: 'adv_00000001', channel: 'card' },
};

describe('canonicalBody', () => {
  it('does not depend on the order the payload keys were written in', () => {
    const one = canonicalBody(1, draft, GENESIS_DIGEST);
    const other = canonicalBody(
      1,
      { ...draft, payload: { channel: 'card', advocate: 'adv_00000001' } },
      GENESIS_DIGEST,
    );
    expect(other).toBe(one);
  });

  it('sorts keys inside a nested object', () => {
    const one = canonicalBody(1, { ...draft, payload: { a: { y: 1, x: 2 } } }, GENESIS_DIGEST);
    const other = canonicalBody(1, { ...draft, payload: { a: { x: 2, y: 1 } } }, GENESIS_DIGEST);
    expect(other).toBe(one);
  });

  it('keeps array order, which is meaningful', () => {
    const one = canonicalBody(1, { ...draft, payload: { a: [1, 2] } }, GENESIS_DIGEST);
    const other = canonicalBody(1, { ...draft, payload: { a: [2, 1] } }, GENESIS_DIGEST);
    expect(other).not.toBe(one);
  });
});

describe('sealRecord', () => {
  it('seals a good draft', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    expect(record.sequence).toBe(1);
    expect(record.previousDigest).toBe(GENESIS_DIGEST);
    expect(record.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic', () => {
    expect(unwrap(sealRecord(1, draft, GENESIS_DIGEST)).digest).toBe(
      unwrap(sealRecord(1, draft, GENESIS_DIGEST)).digest,
    );
  });

  it('changes the digest when the sequence changes', () => {
    expect(unwrap(sealRecord(2, draft, GENESIS_DIGEST)).digest).not.toBe(
      unwrap(sealRecord(1, draft, GENESIS_DIGEST)).digest,
    );
  });

  it('changes the digest when the previous digest changes', () => {
    expect(unwrap(sealRecord(1, draft, 'aaaaaaaa')).digest).not.toBe(
      unwrap(sealRecord(1, draft, GENESIS_DIGEST)).digest,
    );
  });

  it('changes the digest when the payload changes', () => {
    const other = { ...draft, payload: { ...draft.payload, channel: 'link' } };
    expect(unwrap(sealRecord(1, other, GENESIS_DIGEST)).digest).not.toBe(
      unwrap(sealRecord(1, draft, GENESIS_DIGEST)).digest,
    );
  });

  it('refuses a sequence below one', () => {
    const r = sealRecord(0, draft, GENESIS_DIGEST);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('journal_sequence_invalid');
    }
  });

  it('refuses a record with no kind or no key', () => {
    expect(isErr(sealRecord(1, { ...draft, kind: '  ' }, GENESIS_DIGEST))).toBe(true);
    expect(isErr(sealRecord(1, { ...draft, key: '' }, GENESIS_DIGEST))).toBe(true);
  });

  it('accepts an empty payload', () => {
    expect(isErr(sealRecord(1, { ...draft, payload: {} }, GENESIS_DIGEST))).toBe(false);
  });
});

describe('encode and decode', () => {
  it('round trips', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    expect(unwrap(decodeRecord(encodeRecord(record)))).toEqual(record);
  });

  it('writes one line', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    expect(encodeRecord(record)).not.toContain('\n');
  });

  it('refuses a line that is not json', () => {
    const r = decodeRecord('not a record');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('journal_line_unparseable');
    }
  });

  it('refuses json that is not an object', () => {
    expect(isErr(decodeRecord('[1,2,3]'))).toBe(true);
    expect(isErr(decodeRecord('42'))).toBe(true);
    expect(isErr(decodeRecord('null'))).toBe(true);
    expect(isErr(decodeRecord('"a string"'))).toBe(true);
  });

  it('refuses a record missing a field and names it', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    const { digest: _digest, ...rest } = record;
    const r = decodeRecord(JSON.stringify(rest));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('digest');
    }
  });

  it('refuses a record with no payload', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    const r = decodeRecord(JSON.stringify({ ...record, payload: null }));
    expect(isErr(r)).toBe(true);
  });
});

describe('isSealed', () => {
  it('accepts an untouched record', () => {
    expect(isSealed(unwrap(sealRecord(1, draft, GENESIS_DIGEST)))).toBe(true);
  });

  it('sees a payload edited after the fact', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    const tampered = { ...record, payload: { ...record.payload, channel: 'packet' } };
    expect(isSealed(tampered)).toBe(false);
  });

  it('sees a sequence edited after the fact', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    expect(isSealed({ ...record, sequence: 2 })).toBe(false);
  });

  it('sees a previous digest edited after the fact', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    expect(isSealed({ ...record, previousDigest: 'ffffffff' })).toBe(false);
  });

  it('recomputes to the stored digest on a clean record', () => {
    const record = unwrap(sealRecord(1, draft, GENESIS_DIGEST));
    expect(recomputeDigest(record)).toBe(record.digest);
  });
});
