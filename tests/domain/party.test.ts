import { describe, expect, it } from 'vitest';
import { carrierId } from '../../src/domain/identity.js';
import {
  bankDigest,
  describeParty,
  hasOperatingAuthority,
  isFleet,
  isSingleTruck,
  normalizeLegalName,
  normalizePostalCode,
  remitDigest,
  validateParty,
  validateRemitAddress,
  type Party,
  type RemitAddress,
} from '../../src/domain/party.js';
import { isErr, unwrap } from '../../src/util/result.js';

const address: RemitAddress = {
  line1: '4120 W Harrison St',
  city: 'Joliet',
  state: 'IL',
  postalCode: '60431',
};

const party: Party = {
  id: carrierId(1),
  legalName: 'BRANNAN HAULING LLC',
  motorCarrierNumber: 'MC884210',
  dotNumber: '3126540',
  authorityStatus: 'active',
  remit: address,
  powerUnits: 2,
};

describe('normalizeLegalName', () => {
  it('drops the entity suffix and the punctuation', () => {
    expect(normalizeLegalName('Brannan Hauling, L.L.C.')).toBe('BRANNAN HAULING');
    expect(normalizeLegalName('Brannan Hauling Inc')).toBe('BRANNAN HAULING');
  });

  it('collapses two spellings of the same outfit', () => {
    expect(normalizeLegalName('Cobb Transport Co.')).toBe(normalizeLegalName('COBB TRANSPORT'));
  });

  it('leaves a name with no suffix alone', () => {
    expect(normalizeLegalName('Denniston Freight')).toBe('DENNISTON FREIGHT');
  });
});

describe('normalizePostalCode', () => {
  it('cuts a plus four back to five digits', () => {
    expect(normalizePostalCode('60431-2210')).toBe('60431');
    expect(normalizePostalCode(' 60431 ')).toBe('60431');
  });
});

describe('validateRemitAddress', () => {
  it('accepts a good address', () => {
    expect(unwrap(validateRemitAddress(address))).toEqual(address);
  });

  it('rejects a missing street line', () => {
    expect(isErr(validateRemitAddress({ ...address, line1: '  ' }))).toBe(true);
  });

  it('rejects a spelled out state', () => {
    const r = validateRemitAddress({ ...address, state: 'Illinois' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('remit_state_shape');
    }
  });

  it('rejects a postal code that is not one', () => {
    expect(isErr(validateRemitAddress({ ...address, postalCode: '604' }))).toBe(true);
  });

  it('accepts a plus four postal code', () => {
    expect(isErr(validateRemitAddress({ ...address, postalCode: '60431-2210' }))).toBe(false);
  });
});

describe('remitDigest', () => {
  it('collapses casing, punctuation and a plus four', () => {
    const other: RemitAddress = {
      line1: '4120 w. harrison st',
      city: 'joliet',
      state: 'il',
      postalCode: '60431-2210',
    };
    expect(remitDigest(other)).toBe(remitDigest(address));
  });

  it('separates two different addresses', () => {
    expect(remitDigest({ ...address, line1: '4121 W Harrison St' })).not.toBe(remitDigest(address));
  });

  it('separates the same street in two cities', () => {
    expect(remitDigest({ ...address, city: 'Aurora' })).not.toBe(remitDigest(address));
  });
});

describe('bankDigest', () => {
  it('depends on both halves', () => {
    const base = bankDigest({ routingDigest: 'aa', accountDigest: 'bb' });
    expect(bankDigest({ routingDigest: 'aa', accountDigest: 'bc' })).not.toBe(base);
    expect(bankDigest({ routingDigest: 'ab', accountDigest: 'bb' })).not.toBe(base);
  });
});

describe('party predicates', () => {
  it('reads operating authority', () => {
    expect(hasOperatingAuthority(party)).toBe(true);
    expect(hasOperatingAuthority({ ...party, authorityStatus: 'pending' })).toBe(false);
    expect(hasOperatingAuthority({ ...party, authorityStatus: 'revoked' })).toBe(false);
  });

  it('separates a single truck from a fleet', () => {
    expect(isSingleTruck({ ...party, powerUnits: 1 })).toBe(true);
    expect(isSingleTruck({ ...party, powerUnits: 2 })).toBe(false);
    expect(isFleet({ ...party, powerUnits: 5 })).toBe(true);
    expect(isFleet({ ...party, powerUnits: 4 })).toBe(false);
  });

  it('describes a party the way the file room does', () => {
    expect(describeParty(party)).toBe('BRANNAN HAULING LLC (MC884210, DOT 3126540)');
  });
});

describe('validateParty', () => {
  it('accepts a good party', () => {
    expect(unwrap(validateParty(party))).toEqual(party);
  });

  it('rejects a missing name', () => {
    expect(isErr(validateParty({ ...party, legalName: '' }))).toBe(true);
  });

  it('rejects a fractional power unit count', () => {
    const r = validateParty({ ...party, powerUnits: 1.5 });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('party_power_units');
    }
  });

  it('passes the address problem through', () => {
    const r = validateParty({ ...party, remit: { ...address, state: 'ILL' } });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('remit_state_shape');
    }
  });
});
