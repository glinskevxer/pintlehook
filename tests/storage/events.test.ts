import { describe, expect, it } from 'vitest';
import {
  EVENT_KINDS,
  booleanField,
  checkPayload,
  isEventKind,
  numberField,
  optionalTextField,
  readEvent,
  requiredFields,
  textField,
} from '../../src/storage/events.js';
import { GENESIS_DIGEST, sealRecord, type JournalPayload } from '../../src/storage/journal.js';
import { isErr, unwrap } from '../../src/util/result.js';

function record(kind: string, payload: JournalPayload) {
  return unwrap(
    sealRecord(1, { at: Date.UTC(2025, 4, 1), kind, key: 'k', payload }, GENESIS_DIGEST),
  );
}

const qualified: JournalPayload = {
  program: 'prg_00000001',
  invitee: 'cxr_00000009',
  qualifiedOn: '2025-05-01',
};

describe('the kind list', () => {
  it('has no repeats', () => {
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
  });

  it('gives every kind a required field list', () => {
    for (const kind of EVENT_KINDS) {
      expect(requiredFields(kind).length).toBeGreaterThan(0);
    }
  });

  it('recognises and rejects names', () => {
    expect(isEventKind('referral_qualified')).toBe(true);
    expect(isEventKind('referral_maybe')).toBe(false);
  });
});

describe('checkPayload', () => {
  it('accepts a complete payload', () => {
    expect(unwrap(checkPayload('referral_qualified', qualified))).toEqual(qualified);
  });

  it('names every field that is missing', () => {
    const r = checkPayload('referral_qualified', { program: 'prg_00000001' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.message).toContain('invitee');
      expect(r.problems[0]!.message).toContain('qualifiedOn');
    }
  });

  it('treats a null as missing', () => {
    expect(isErr(checkPayload('referral_qualified', { ...qualified, invitee: null }))).toBe(true);
  });

  it('allows extra fields', () => {
    expect(isErr(checkPayload('referral_qualified', { ...qualified, extra: 1 }))).toBe(false);
  });
});

describe('readEvent', () => {
  it('reads a good record', () => {
    const read = unwrap(readEvent(record('referral_qualified', qualified)));
    expect(read.kind).toBe('referral_qualified');
  });

  it('refuses a kind nobody has heard of', () => {
    const r = readEvent(record('referral_maybe', qualified));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('event_kind_unknown');
      expect(r.problems[0]!.message).toContain('referral_maybe');
    }
  });

  it('refuses a known kind with a short payload', () => {
    const r = readEvent(record('referral_qualified', { program: 'prg_00000001' }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('event_payload_incomplete');
    }
  });
});

describe('field readers', () => {
  const payload: JournalPayload = { a: 'text', b: 42, c: true, d: null };

  it('reads text', () => {
    expect(unwrap(textField(payload, 'a'))).toBe('text');
    expect(isErr(textField(payload, 'b'))).toBe(true);
    expect(isErr(textField(payload, 'missing'))).toBe(true);
  });

  it('reads a number', () => {
    expect(unwrap(numberField(payload, 'b'))).toBe(42);
    expect(isErr(numberField(payload, 'a'))).toBe(true);
  });

  it('refuses a number that is not finite', () => {
    expect(isErr(numberField({ n: Number.NaN }, 'n'))).toBe(true);
  });

  it('reads a boolean', () => {
    expect(unwrap(booleanField(payload, 'c'))).toBe(true);
    expect(isErr(booleanField(payload, 'b'))).toBe(true);
  });

  it('reads optional text as nothing when it is not text', () => {
    expect(optionalTextField(payload, 'a')).toBe('text');
    expect(optionalTextField(payload, 'b')).toBeUndefined();
    expect(optionalTextField(payload, 'd')).toBeUndefined();
    expect(optionalTextField(payload, 'missing')).toBeUndefined();
  });
});
