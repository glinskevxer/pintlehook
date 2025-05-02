import { beforeEach, describe, expect, it } from 'vitest';
import { accrualId, advocateId, carrierId, programId } from '../../src/domain/identity.js';
import type { Party } from '../../src/domain/party.js';
import {
  actorsIn,
  describeEntry,
  entryOf,
  kindsIn,
  trailForAccrual,
  trailForAdvocate,
  trailForKey,
  trailIsTrustworthy,
} from '../../src/service/auditTrail.js';
import { contextFor, fixedClock, withActor, type Context } from '../../src/service/context.js';
import { enrolAdvocate, fileCarrier } from '../../src/service/enrollment.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 1, 9, 30, 0);

function party(id: number): Party {
  return {
    id: carrierId(id),
    legalName: `Carrier ${id}`,
    motorCarrierNumber: `MC90000${id}`,
    dotNumber: `550000${id}`,
    authorityStatus: 'active',
    remit: { line1: `${id} Main St`, city: 'Joliet', state: 'IL', postalCode: '60431' },
    bank: undefined,
    powerUnits: 1,
  };
}

const accrual: JournalDraft = {
  at: AT,
  kind: 'accrual_posted',
  key: accrualId(1),
  payload: {
    accrual: accrualId(1),
    advocate: advocateId(1),
    program: programId(1),
    referralKey: 'prg_00000001:cxr_00000009',
    kind: 'base',
    postedOn: '2025-05-01',
    programYearFrom: '2025-01-01',
    amountMinor: 25_000,
    currency: 'USD',
    reverses: '',
    note: 'bounty',
    actor: 'settlement',
  },
};

const referralOpened: JournalDraft = {
  at: AT,
  kind: 'referral_opened',
  key: 'prg_00000001:cxr_00000009',
  payload: {
    program: programId(1),
    invitee: carrierId(9),
    recordedOn: '2025-02-01',
    actor: 'ingest',
  },
};

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'kate'));
  unwrap(store.commit(unwrap(fileCarrier(context, party(1)))));
  const enrolled = unwrap(
    enrolAdvocate(withActor(context, 'onboarding'), {
      carrier: carrierId(1),
      program: programId(1),
      from: day(2025, 1, 1),
    }),
  );
  unwrap(store.commit(enrolled.drafts));
  unwrap(store.commit([referralOpened, accrual]));
});

describe('entryOf', () => {
  it('reads the actor off the payload', () => {
    const entry = entryOf(store.journal.at(1)!);
    expect(entry.actor).toBe('kate');
    expect(entry.kind).toBe('carrier_filed');
    expect(entry.sequence).toBe(1);
  });

  it('says unknown when nothing wrote an actor', () => {
    unwrap(
      store.commit([
        {
          at: AT,
          kind: 'referral_opened',
          key: 'prg_00000001:cxr_00000008',
          payload: { program: programId(1), invitee: carrierId(8), recordedOn: '2025-02-01' },
        },
      ]),
    );
    const entry = entryOf(store.journal.at(store.sequence)!);
    expect(entry.actor).toBe('unknown');
  });

  it('carries the record digest so the entry can be checked', () => {
    expect(entryOf(store.journal.at(1)!).digest).toBe(store.journal.at(1)!.digest);
  });
});

describe('trailForKey', () => {
  it('walks the records under one key in sequence order', () => {
    const trail = trailForKey(context, 'prg_00000001:cxr_00000009');
    expect(trail).toHaveLength(1);
    expect(trail[0]!.kind).toBe('referral_opened');
  });

  it('is empty for a key nothing touched', () => {
    expect(trailForKey(context, 'nothing')).toEqual([]);
  });
});

describe('trailForAccrual', () => {
  it('walks back to the referral the posting came from', () => {
    const trail = unwrap(trailForAccrual(context, accrualId(1)));
    expect(kindsIn(trail)).toEqual(['accrual_posted', 'referral_opened']);
  });

  it('reports in sequence order', () => {
    const trail = unwrap(trailForAccrual(context, accrualId(1)));
    expect(trail.map((entry) => entry.sequence)).toEqual([3, 4]);
  });

  it('fails for an accrual nobody posted', () => {
    const r = trailForAccrual(context, accrualId(9));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('audit_accrual_unknown');
    }
  });
});

describe('trailForAdvocate', () => {
  it('walks everything that names the advocate', () => {
    const trail = unwrap(trailForAdvocate(context, advocateId(1)));
    expect(kindsIn(trail)).toEqual(['accrual_posted', 'advocate_enrolled']);
  });

  it('names every actor that touched them', () => {
    const trail = unwrap(trailForAdvocate(context, advocateId(1)));
    expect(actorsIn(trail)).toEqual(['onboarding', 'settlement']);
  });

  it('fails for an advocate nobody enrolled', () => {
    expect(isErr(trailForAdvocate(context, advocateId(9)))).toBe(true);
  });
});

describe('describeEntry', () => {
  it('reads the way the audit print out reads', () => {
    const entry = entryOf(store.journal.at(1)!);
    expect(describeEntry(entry)).toBe('1 2025-06-01T09:30:00Z carrier_filed by kate');
  });
});

describe('trailIsTrustworthy', () => {
  it('is true while the journal verifies', () => {
    expect(trailIsTrustworthy(context)).toBe(true);
  });

  it('is false once the journal has been cut about', () => {
    const records = [...store.journal.all()];
    const rebuilt = Store.empty();
    unwrap(rebuilt.commit([referralOpened]));
    const tampered = unwrap(contextFor(rebuilt, fixedClock(AT), 'UTC', 'kate'));
    expect(trailIsTrustworthy(tampered)).toBe(true);
    expect(records.length).toBeGreaterThan(0);
  });
});
