import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  codeBodyFor,
  enrolAdvocate,
  fileCarrier,
  referralCodeFor,
  withdrawAdvocate,
} from '../../src/service/enrollment.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { parseReferralCode } from '../../src/util/ids.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 0, 15, 12, 0, 0);

const party: Party = {
  id: carrierId(1),
  legalName: 'Brannan Hauling LLC',
  motorCarrierNumber: 'MC884210',
  dotNumber: '3126540',
  authorityStatus: 'active',
  remit: { line1: '4120 W Harrison St', city: 'Joliet', state: 'IL', postalCode: '60431' },
  bank: { routingDigest: 'r1', accountDigest: 'a1' },
  powerUnits: 2,
};

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'desk'));
});

describe('referral codes', () => {
  it('are deterministic for an advocate', () => {
    expect(codeBodyFor(advocateId(4))).toBe(codeBodyFor(advocateId(4)));
    expect(unwrap(referralCodeFor(advocateId(4)))).toBe(unwrap(referralCodeFor(advocateId(4))));
  });

  it('differ between advocates', () => {
    expect(codeBodyFor(advocateId(4))).not.toBe(codeBodyFor(advocateId(5)));
  });

  it('pass their own check character', () => {
    const code = unwrap(referralCodeFor(advocateId(4)));
    expect(unwrap(parseReferralCode(code))).toBe(code);
  });

  it('use only the code alphabet', () => {
    expect(codeBodyFor(advocateId(99))).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });
});

describe('fileCarrier', () => {
  it('writes a carrier record', () => {
    const drafts = unwrap(fileCarrier(context, party));
    unwrap(store.commit(drafts));
    expect(store.carriers.get(carrierId(1))!.legalName).toBe('Brannan Hauling LLC');
  });

  it('digests the remit and the bank rather than storing them', () => {
    const drafts = unwrap(fileCarrier(context, party));
    const payload = drafts[0]!.payload;
    expect(payload['remitDigest']).toMatch(/^[0-9a-f]{8}$/);
    expect(payload['bankDigest']).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(payload)).not.toContain('Harrison');
  });

  it('leaves the bank digest empty when there is no account', () => {
    const drafts = unwrap(fileCarrier(context, { ...party, bank: undefined }));
    expect(drafts[0]!.payload['bankDigest']).toBe('');
  });

  it('refuses a party that does not validate', () => {
    expect(isErr(fileCarrier(context, { ...party, legalName: '' }))).toBe(true);
  });

  it('stamps the actor', () => {
    expect(unwrap(fileCarrier(context, party))[0]!.payload['actor']).toBe('desk');
  });
});

describe('enrolAdvocate', () => {
  beforeEach(() => {
    unwrap(store.commit(unwrap(fileCarrier(context, party))));
  });

  it('enrols a carrier with active authority', () => {
    const enrolled = unwrap(
      enrolAdvocate(context, {
        carrier: carrierId(1),
        program: programId(1),
        from: day(2025, 1, 15),
      }),
    );
    unwrap(store.commit(enrolled.drafts));
    expect(store.advocates.get(enrolled.advocate)!.referralCode).toBe(enrolled.referralCode);
  });

  it('refuses a carrier whose authority is not active', () => {
    const pending = unwrap(fileCarrier(context, { ...party, authorityStatus: 'pending' }));
    unwrap(store.commit(pending));
    const r = enrolAdvocate(context, {
      carrier: carrierId(1),
      program: programId(1),
      from: day(2025, 1, 15),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('enrolment_authority_not_active');
    }
  });

  it('refuses a carrier that is not filed', () => {
    const r = enrolAdvocate(context, {
      carrier: carrierId(9),
      program: programId(1),
      from: day(2025, 1, 15),
    });
    expect(isErr(r)).toBe(true);
  });

  it('refuses a second open enrolment on the same program', () => {
    const first = unwrap(
      enrolAdvocate(context, {
        carrier: carrierId(1),
        program: programId(1),
        from: day(2025, 1, 15),
      }),
    );
    unwrap(store.commit(first.drafts));
    const again = enrolAdvocate(context, {
      carrier: carrierId(1),
      program: programId(1),
      from: day(2025, 2, 1),
    });
    expect(isErr(again)).toBe(true);
    if (isErr(again)) {
      expect(again.problems[0]!.code).toBe('enrolment_already_open');
    }
  });

  it('allows the same carrier on a second program', () => {
    const first = unwrap(
      enrolAdvocate(context, {
        carrier: carrierId(1),
        program: programId(1),
        from: day(2025, 1, 15),
      }),
    );
    unwrap(store.commit(first.drafts));
    const second = enrolAdvocate(context, {
      carrier: carrierId(1),
      program: programId(2),
      from: day(2025, 1, 15),
    });
    expect(isErr(second)).toBe(false);
  });
});

describe('withdrawAdvocate', () => {
  beforeEach(() => {
    unwrap(store.commit(unwrap(fileCarrier(context, party))));
    const enrolled = unwrap(
      enrolAdvocate(context, {
        carrier: carrierId(1),
        program: programId(1),
        from: day(2025, 1, 15),
      }),
    );
    unwrap(store.commit(enrolled.drafts));
  });

  it('closes the spell', () => {
    const advocate = store.advocates.all()[0]!.id;
    unwrap(
      store.commit(
        unwrap(withdrawAdvocate(context, advocate as never, day(2025, 6, 1), 'withdrew')),
      ),
    );
    expect(store.advocates.get(advocate)!.enrolledUntil).toBe('2025-06-01');
  });

  it('refuses to withdraw twice', () => {
    const advocate = store.advocates.all()[0]!.id;
    unwrap(
      store.commit(
        unwrap(withdrawAdvocate(context, advocate as never, day(2025, 6, 1), 'withdrew')),
      ),
    );
    const again = withdrawAdvocate(context, advocate as never, day(2025, 7, 1), 'withdrew');
    expect(isErr(again)).toBe(true);
    if (isErr(again)) {
      expect(again.problems[0]!.code).toBe('enrolment_not_open');
    }
  });

  it('refuses an end on the day it began', () => {
    const advocate = store.advocates.all()[0]!.id;
    const r = withdrawAdvocate(context, advocate as never, day(2025, 1, 15), 'withdrew');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('enrolment_end_before_start');
    }
  });

  it('refuses somebody who was never enrolled', () => {
    expect(isErr(withdrawAdvocate(context, advocateId(99), day(2025, 6, 1), 'withdrew'))).toBe(
      true,
    );
  });
});
