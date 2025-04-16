import { beforeEach, describe, expect, it } from 'vitest';
import { advocateId, carrierId, programId } from '../../src/domain/identity.js';
import { contextFor, fixedClock, type Context } from '../../src/service/context.js';
import {
  KNOWN_FLAGS,
  blocksPayment,
  clearFlag,
  flagHistory,
  isKnownFlag,
  openFlagsAcross,
  raiseFlag,
} from '../../src/service/eligibility.js';
import type { JournalDraft } from '../../src/storage/journal.js';
import { Store } from '../../src/storage/store.js';
import { day } from '../../src/util/clock.js';
import { isErr, unwrap } from '../../src/util/result.js';

const AT = Date.UTC(2025, 5, 1);

function carrier(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'carrier_filed',
    key: carrierId(id),
    payload: {
      carrier: carrierId(id),
      legalName: `Carrier ${id}`,
      motorCarrierNumber: `MC90000${id}`,
      dotNumber: `550000${id}`,
      authorityStatus: 'active',
      remitDigest: `r${id}`,
      bankDigest: `b${id}`,
      powerUnits: 1,
    },
  };
}

function enrolled(id: number): JournalDraft {
  return {
    at: AT,
    kind: 'advocate_enrolled',
    key: advocateId(id),
    payload: {
      advocate: advocateId(id),
      carrier: carrierId(id),
      program: programId(1),
      referralCode: `CODE00${id}`,
      from: '2025-01-01',
    },
  };
}

let store: Store;
let context: Context;

beforeEach(() => {
  store = Store.empty();
  context = unwrap(contextFor(store, fixedClock(AT), 'America/Chicago', 'kate'));
  unwrap(store.commit([carrier(1), carrier(2), enrolled(1), enrolled(2)]));
});

describe('the flag list', () => {
  it('has no repeats', () => {
    expect(new Set(KNOWN_FLAGS).size).toBe(KNOWN_FLAGS.length);
  });

  it('recognises and rejects names', () => {
    expect(isKnownFlag('fraud_review')).toBe(true);
    expect(isKnownFlag('feels_wrong')).toBe(false);
  });
});

describe('raiseFlag', () => {
  it('raises a flag on an enrolled advocate', () => {
    unwrap(store.commit(unwrap(raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 3, 1)))));
    expect(blocksPayment(context, advocateId(1))).toBe(true);
  });

  it('refuses a flag nobody has heard of', () => {
    const r = raiseFlag(context, advocateId(1), 'feels_wrong', day(2025, 3, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('eligibility_flag_unknown');
    }
  });

  it('refuses an advocate nobody enrolled', () => {
    expect(isErr(raiseFlag(context, advocateId(9), 'w9_missing', day(2025, 3, 1)))).toBe(true);
  });

  it('refuses to raise the same flag twice', () => {
    unwrap(store.commit(unwrap(raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 3, 1)))));
    const r = raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 4, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('eligibility_flag_already_open');
    }
  });

  it('allows two different flags at once', () => {
    unwrap(store.commit(unwrap(raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 3, 1)))));
    unwrap(
      store.commit(unwrap(raiseFlag(context, advocateId(1), 'fraud_review', day(2025, 3, 2)))),
    );
    expect(openFlagsAcross(context, programId(1))[0]!.open).toHaveLength(2);
  });

  it('names who raised it', () => {
    const drafts = unwrap(raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 3, 1)));
    expect(drafts[0]!.payload['actor']).toBe('kate');
  });
});

describe('clearFlag', () => {
  beforeEach(() => {
    unwrap(store.commit(unwrap(raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 3, 1)))));
  });

  it('clears an open flag', () => {
    unwrap(store.commit(unwrap(clearFlag(context, advocateId(1), 'w9_missing', day(2025, 4, 1)))));
    expect(blocksPayment(context, advocateId(1))).toBe(false);
  });

  it('refuses to clear twice', () => {
    unwrap(store.commit(unwrap(clearFlag(context, advocateId(1), 'w9_missing', day(2025, 4, 1)))));
    const r = clearFlag(context, advocateId(1), 'w9_missing', day(2025, 5, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('eligibility_flag_not_open');
    }
  });

  it('refuses a flag that was never raised', () => {
    const r = clearFlag(context, advocateId(1), 'fraud_review', day(2025, 4, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('eligibility_flag_not_raised');
    }
  });

  it('refuses a clearing dated before the raise', () => {
    const r = clearFlag(context, advocateId(1), 'w9_missing', day(2025, 2, 1));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.problems[0]!.code).toBe('eligibility_flag_cleared_early');
    }
  });

  it('allows clearing on the day it was raised', () => {
    expect(isErr(clearFlag(context, advocateId(1), 'w9_missing', day(2025, 3, 1)))).toBe(false);
  });

  it('lets the same flag be raised again after clearing', () => {
    unwrap(store.commit(unwrap(clearFlag(context, advocateId(1), 'w9_missing', day(2025, 4, 1)))));
    expect(isErr(raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 5, 1)))).toBe(false);
  });
});

describe('openFlagsAcross', () => {
  it('lists only the advocates with something open, in order', () => {
    unwrap(store.commit(unwrap(raiseFlag(context, advocateId(2), 'w9_missing', day(2025, 3, 1)))));
    unwrap(
      store.commit(unwrap(raiseFlag(context, advocateId(1), 'fraud_review', day(2025, 3, 1)))),
    );
    const found = openFlagsAcross(context, programId(1));
    expect(found.map((entry) => entry.advocate)).toEqual([advocateId(1), advocateId(2)]);
  });

  it('is empty when everybody is clear', () => {
    expect(openFlagsAcross(context, programId(1))).toEqual([]);
  });
});

describe('flagHistory', () => {
  it('keeps a cleared flag on the file', () => {
    unwrap(store.commit(unwrap(raiseFlag(context, advocateId(1), 'w9_missing', day(2025, 3, 1)))));
    unwrap(store.commit(unwrap(clearFlag(context, advocateId(1), 'w9_missing', day(2025, 4, 1)))));
    const history = flagHistory(context, advocateId(1));
    expect(history).toHaveLength(1);
    expect(history[0]!.clearedOn).toBe('2025-04-01');
  });

  it('is empty for an advocate who never had one', () => {
    expect(flagHistory(context, advocateId(2))).toEqual([]);
  });
});
