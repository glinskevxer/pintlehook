import { describe, expect, it } from 'vitest';
import {
  ID_PREFIXES,
  accrualId,
  advocateId,
  batchId,
  carrierId,
  claimId,
  kindOf,
  loadId,
  programId,
  readAccrualId,
  readAdvocateId,
  readBatchId,
  readCarrierId,
  readClaimId,
  readLoadId,
  readProgramId,
  readSettlementId,
  readTouchId,
  sequenceOf,
  settlementId,
  touchId,
} from '../../src/domain/identity.js';
import { isErr, unwrap } from '../../src/util/result.js';

describe('prefixes', () => {
  it('gives every kind its own prefix', () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('minting', () => {
  it('mints each kind with its prefix', () => {
    expect(advocateId(1)).toBe('adv_00000001');
    expect(carrierId(2)).toBe('cxr_00000002');
    expect(programId(3)).toBe('prg_00000003');
    expect(touchId(4)).toBe('tch_00000004');
    expect(loadId(5)).toBe('lod_00000005');
    expect(claimId(6)).toBe('clm_00000006');
    expect(accrualId(7)).toBe('acr_00000007');
    expect(settlementId(8)).toBe('stl_00000008');
    expect(batchId(9)).toBe('bch_00000009');
  });

  it('sorts lexically in sequence order', () => {
    const ids = [advocateId(10), advocateId(2), advocateId(1)].sort();
    expect(ids).toEqual([advocateId(1), advocateId(2), advocateId(10)]);
  });
});

describe('reading', () => {
  it('accepts an identifier of the right kind', () => {
    expect(unwrap(readAdvocateId(advocateId(12)))).toBe('adv_00000012');
  });

  it('refuses an identifier of the wrong kind', () => {
    const r = readAdvocateId(carrierId(12));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('identifier_kind');
      expect(r.problems[0]!.message).toContain('adv');
    }
  });

  it('refuses something that is not an identifier at all', () => {
    expect(isErr(readAdvocateId('advocate 12'))).toBe(true);
  });

  it('checks every reader against its own kind', () => {
    expect(isErr(readCarrierId(advocateId(1)))).toBe(true);
    expect(isErr(readProgramId(advocateId(1)))).toBe(true);
    expect(isErr(readTouchId(advocateId(1)))).toBe(true);
    expect(isErr(readLoadId(advocateId(1)))).toBe(true);
    expect(isErr(readClaimId(advocateId(1)))).toBe(true);
    expect(isErr(readAccrualId(advocateId(1)))).toBe(true);
    expect(isErr(readSettlementId(advocateId(1)))).toBe(true);
    expect(isErr(readBatchId(advocateId(1)))).toBe(true);
  });
});

describe('kindOf', () => {
  it('names the kind of a known prefix', () => {
    expect(kindOf(settlementId(3))).toBe('settlement');
    expect(kindOf(batchId(3))).toBe('batch');
  });

  it('returns nothing for an unknown prefix', () => {
    expect(kindOf('zzz_00000001')).toBeUndefined();
  });

  it('returns nothing for a malformed identifier', () => {
    expect(kindOf('adv-1')).toBeUndefined();
  });
});

describe('sequenceOf', () => {
  it('reads the sequence back', () => {
    expect(unwrap(sequenceOf(loadId(4021)))).toBe(4021);
  });

  it('fails on a malformed identifier', () => {
    expect(isErr(sequenceOf('lod-4021'))).toBe(true);
  });
});
