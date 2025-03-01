import { beforeEach, describe, expect, it } from 'vitest';
import {
  basisStrength,
  describeResolution,
  isInferred,
  resolveCarrier,
} from '../../src/service/resolution.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 4, 1);

function carrier(id: string, legalName: string, mc: string, dot: string): JournalDraft {
  return {
    at: AT,
    kind: 'carrier_filed',
    key: id,
    payload: {
      carrier: id,
      legalName,
      motorCarrierNumber: mc,
      dotNumber: dot,
      authorityStatus: 'active',
      remitDigest: 'r',
      bankDigest: 'b',
      powerUnits: 1,
    },
  };
}

let store: Store;

beforeEach(() => {
  store = Store.empty();
  unwrap(
    store.commit([
      carrier('cxr_1', 'Brannan Hauling LLC', 'MC884210', '3126540'),
      carrier('cxr_2', 'Delacroix Transport Inc', 'MC991002', '4410781'),
      carrier('cxr_3', 'Delta Transport', 'MC700001', '4410781'),
      carrier('cxr_4', 'Delta Transport Co.', 'MC700002', '5500001'),
    ]),
  );
});

describe('by motor carrier number', () => {
  it('resolves an exact number', () => {
    const resolved = unwrap(resolveCarrier(store, { motorCarrierNumber: 'MC884210' }));
    expect(resolved.carrier.id).toBe('cxr_1');
    expect(resolved.basis).toBe('motor_carrier_number');
  });

  it('resolves a number written another way', () => {
    expect(unwrap(resolveCarrier(store, { motorCarrierNumber: 'mc-0884210' })).carrier.id).toBe(
      'cxr_1',
    );
  });

  it('falls through when the number matches nothing', () => {
    const r = resolveCarrier(store, { motorCarrierNumber: 'MC000001', dotNumber: '5500001' });
    expect(unwrap(r).carrier.id).toBe('cxr_4');
  });

  it('falls through when the number is not a number', () => {
    const r = resolveCarrier(store, { motorCarrierNumber: 'pending', dotNumber: '3126540' });
    expect(unwrap(r).carrier.id).toBe('cxr_1');
  });
});

describe('by dot number', () => {
  it('resolves when exactly one file carries it', () => {
    const resolved = unwrap(resolveCarrier(store, { dotNumber: 'USDOT 3126540' }));
    expect(resolved.carrier.id).toBe('cxr_1');
    expect(resolved.basis).toBe('dot_number');
  });

  it('refuses when two files share it', () => {
    const r = resolveCarrier(store, { dotNumber: '4410781' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('resolution_dot_ambiguous');
    }
  });

  it('does not fall through to the name once the dot number is ambiguous', () => {
    const r = resolveCarrier(store, { dotNumber: '4410781', legalName: 'Brannan Hauling' });
    expect(isErr(r)).toBe(true);
  });
});

describe('by legal name', () => {
  it('resolves when exactly one file trades as it', () => {
    const resolved = unwrap(resolveCarrier(store, { legalName: 'brannan hauling, inc' }));
    expect(resolved.carrier.id).toBe('cxr_1');
    expect(resolved.basis).toBe('legal_name');
  });

  it('refuses when two files trade as it', () => {
    const r = resolveCarrier(store, { legalName: 'Delta Transport' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('resolution_name_ambiguous');
    }
  });

  it('refuses a name that matches nothing', () => {
    const r = resolveCarrier(store, { legalName: 'Nobody Freight' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('resolution_no_match');
    }
  });

  it('ignores a name that normalises to nothing', () => {
    expect(isErr(resolveCarrier(store, { legalName: 'LLC' }))).toBe(true);
  });
});

describe('with nothing to go on', () => {
  it('says so', () => {
    expect(isErr(resolveCarrier(store, {}))).toBe(true);
  });
});

describe('basis', () => {
  it('ranks the regulator issued numbers above a trading name', () => {
    expect(basisStrength('motor_carrier_number')).toBeGreaterThan(basisStrength('dot_number'));
    expect(basisStrength('dot_number')).toBeGreaterThan(basisStrength('legal_name'));
  });

  it('calls only a name match inferred', () => {
    expect(isInferred('legal_name')).toBe(true);
    expect(isInferred('motor_carrier_number')).toBe(false);
  });

  it('describes what it matched on', () => {
    const resolved = unwrap(resolveCarrier(store, { motorCarrierNumber: 'MC884210' }));
    expect(describeResolution(resolved)).toBe('cxr_1 on motor_carrier_number');
  });
});
